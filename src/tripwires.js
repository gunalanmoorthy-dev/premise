// Tripwire engine: decides whether each saved assumption still holds.
// Used by the "Check now" button (as the user) and the hourly check (as the app).

import { route } from '@forge/api';

// How many matching issues to show as evidence when a wire trips.
const SAMPLE_SIZE = 5;

// Label on Premise's own revisit tickets.
export const REVISIT_LABEL = 'premise-revisit';

// An issue key, used to keep anything else out of the JQL we build.
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

// Keep only the strings that really are issue keys, upper-cased and deduplicated.
export const cleanIssueKeys = (keys) =>
  Array.from(
    new Set(
      (Array.isArray(keys) ? keys : [])
        .map((k) => String(k).trim().toUpperCase())
        .filter((k) => ISSUE_KEY.test(k))
    )
  );

// Build the query Premise actually runs: the user's search, minus Premise's own
// revisit tickets (or a broken wire would feed itself), minus the issues someone
// has marked as not relevant to this assumption.
function buildJql(jql, exclude) {
  let q = `(${jql}) AND (labels is EMPTY OR labels != "${REVISIT_LABEL}")`;
  const keys = cleanIssueKeys(exclude);
  if (keys.length) q += ` AND key NOT IN (${keys.join(', ')})`;
  return q;
}

// Repair a common AI slip in JQL: clauses joined by commas instead of AND.
// "a OR b, statusCategory != Done" becomes "(a OR b) AND (statusCategory != Done)".
export function repairJql(jql) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  let depth = 0; // commas inside brackets are valid JQL, e.g. status in (Open, Done)
  for (const ch of String(jql || '')) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && ch === '(') depth += 1;
    if (!inQuotes && ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && !inQuotes && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  return clean.length > 1 ? clean.map((p) => `(${p})`).join(' AND ') : clean[0] || '';
}

// Ask Jira whether each JQL query is valid. Returns one error string (or null) per query.
export async function validateJql(requester, queries) {
  if (queries.length === 0) return [];
  const res = await requester.requestJira(route`/rest/api/3/jql/parse?validation=strict`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries }),
  });
  if (!res.ok) return queries.map(() => null); // cannot validate: let the check report it later
  const data = await res.json();
  return (data.queries || []).map((q) => (q.errors && q.errors.length ? q.errors.join(' ') : null));
}

// Count Jira issues matching a JQL query.
async function countIssues(requester, jql) {
  const res = await requester.requestJira(route`/rest/api/3/search/approximate-count`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira rejected the search (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Number(data.count || 0);
}

// Fetch a few matching issues to show as evidence.
async function sampleIssues(requester, jql) {
  const res = await requester.requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, maxResults: SAMPLE_SIZE, fields: ['summary'] }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.issues || []).map((i) => ({ key: i.key, summary: i.fields?.summary || '' }));
}

// Check one assumption. Returns the assumption with fresh status and evidence.
export async function checkAssumption(requester, assumption) {
  const tripwire = assumption.tripwire || { type: 'none' };
  const checkedAt = new Date().toISOString();

  try {
    if (tripwire.type === 'jql' && tripwire.jql) {
      const threshold = Number(tripwire.threshold ?? 0);
      const dismissed = cleanIssueKeys(tripwire.exclude);
      const jql = buildJql(tripwire.jql, dismissed);
      const count = await countIssues(requester, jql);
      const broken = count > threshold;
      // Say out loud when a human has narrowed the signal, so the number is never
      // mistaken for everything the search matches.
      const note = dismissed.length
        ? `, ${dismissed.length} not counted (marked not relevant)`
        : '';
      return {
        ...assumption,
        status: broken ? 'broken' : 'holding',
        checkedAt,
        evidence: {
          summary: `${count} matching issue${count === 1 ? '' : 's'} (limit ${threshold})${note}`,
          issues: broken ? await sampleIssues(requester, jql) : [],
          dismissed,
        },
      };
    }

    if (tripwire.type === 'date' && tripwire.date) {
      const today = new Date().toISOString().slice(0, 10);
      const broken = today >= tripwire.date;
      return {
        ...assumption,
        status: broken ? 'broken' : 'holding',
        checkedAt,
        evidence: {
          summary: broken ? `Date reached: ${tripwire.date}` : `Watching until ${tripwire.date}`,
          issues: [],
        },
      };
    }

    return { ...assumption, status: 'unwatched', checkedAt, evidence: null };
  } catch (e) {
    return {
      ...assumption,
      status: 'error',
      checkedAt,
      evidence: { summary: e.message, issues: [] },
    };
  }
}

// Run a candidate tripwire without saving it, so the panel can show what the
// search matches today. Setting a limit blind is how a wire ends up either
// already tripped or impossible to trip.
export async function previewJql(requester, rawJql, exclude) {
  const jql = repairJql(rawJql);
  if (!jql) return { ok: false, error: 'Enter a Jira search first.' };
  const [invalid] = await validateJql(requester, [jql]);
  if (invalid) return { ok: false, error: invalid, jql };
  const full = buildJql(jql, exclude);
  try {
    const count = await countIssues(requester, full);
    return { ok: true, jql, count, issues: await sampleIssues(requester, full) };
  } catch (e) {
    return { ok: false, error: e.message, jql };
  }
}

// Small helpers to build Jira's rich-text (ADF) description.
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const linkPara = (label, href) => ({
  type: 'paragraph',
  content: [{ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }],
});

// Open one "Revisit decision" ticket for an assumption that just broke.
async function createRevisitTicket(requester, record, assumption) {
  const content = [
    para(`The assumption "${assumption.text}" behind this decision no longer holds.`),
    para(`Decision: ${record.decision || record.pageTitle || 'see linked page'}`),
    para(`Evidence: ${assumption.evidence?.summary || 'n/a'}`),
  ];
  for (const i of assumption.evidence?.issues || []) {
    content.push(para(`- ${i.key}: ${i.summary}`));
  }
  if (record.pageUrl) content.push(linkPara('Open the decision page', record.pageUrl));

  const fields = {
    project: { key: record.ticketProjectKey },
    issuetype: { name: 'Task' },
    summary: `Revisit decision: ${String(record.pageTitle || record.decision || 'decision').replace(/^decision:\s*/i, '')}`.slice(0, 250),
    description: { type: 'doc', version: 1, content },
    labels: [REVISIT_LABEL],
  };

  const post = (body) =>
    requester.requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: body }),
    });

  // Assign to the person who saved the decision, so Jira notifies them.
  let assigned = Boolean(record.savedBy);
  let res = await post(assigned ? { ...fields, assignee: { accountId: record.savedBy } } : fields);

  // If Jira refuses the assignee, still open the ticket, just unassigned.
  if (!res.ok && assigned && res.status === 400) {
    console.warn(`Revisit ticket: assignee refused, retrying unassigned (${(await res.text()).slice(0, 150)})`);
    assigned = false;
    res = await post(fields);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not create Jira ticket (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    key: data.key,
    assignee: assigned ? record.savedBy : null,
    createdAt: new Date().toISOString(),
  };
}

// Is a revisit ticket still open? A closed one means the team dealt with the
// question, so the next break deserves a fresh ticket rather than reopening an
// argument somebody already settled.
async function isTicketOpen(requester, key) {
  try {
    const res = await requester.requestJira(route`/rest/api/3/issue/${key}?fields=status`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return false; // deleted, or not visible to this requester
    const data = await res.json();
    return data.fields?.status?.statusCategory?.key !== 'done';
  } catch (e) {
    console.warn(`Could not read revisit ticket ${key}: ${e.message}`);
    return false;
  }
}

// Check every assumption in one page record.
// When an assumption newly breaks and a ticket project is set, open one revisit ticket.
export async function checkRecord(requester, record) {
  const assumptions = [];
  for (const before of record.assumptions || []) {
    const after = await checkAssumption(requester, before);

    if (after.status === 'broken') {
      const alreadyTicketed = before.status === 'broken' && before.ticket;
      if (alreadyTicketed) {
        after.ticket = before.ticket;
      } else if (record.ticketProjectKey) {
        // This wire may have recovered and broken again. A count that hovers
        // around its limit would otherwise open a fresh ticket every hourly
        // check, so reuse the earlier one while it is still open.
        const earlier = before.pastTicket?.key ? before.pastTicket : null;
        const reusable = earlier && (await isTicketOpen(requester, earlier.key));
        if (reusable) {
          after.ticket = earlier;
          after.ticketError = null;
        } else {
          try {
            after.ticket = await createRevisitTicket(requester, record, after);
            after.ticketError = null;
          } catch (e) {
            after.ticket = null;
            after.ticketError = e.message;
          }
        }
      }
      after.pastTicket = null; // the live ticket is the one that matters now
    } else if (after.status === 'holding') {
      // Recovered: the next break gets a fresh ticket. Remember the old one,
      // because it is still sitting open in Jira and somebody has to close it.
      after.ticket = null;
      after.ticketError = null;
      after.pastTicket = before.ticket || before.pastTicket || null;
    } else {
      after.ticket = before.ticket || null;
      after.pastTicket = before.pastTicket || null;
    }
    assumptions.push(after);
  }
  const brokenCount = assumptions.filter((a) => a.status === 'broken').length;
  return { ...record, assumptions, brokenCount, lastCheckedAt: new Date().toISOString() };
}
