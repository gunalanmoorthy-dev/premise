// Tripwire engine: decides whether each saved assumption still holds.
// Used by the "Check now" button (as the user) and the hourly check (as the app).

import { route } from '@forge/api';

// How many matching issues to show as evidence when a wire trips.
const SAMPLE_SIZE = 5;

// Label on Premise's own revisit tickets.
export const REVISIT_LABEL = 'premise-revisit';

// Never count Premise's own revisit tickets, or a broken wire would feed itself.
const excludeOwnTickets = (jql) =>
  `(${jql}) AND (labels is EMPTY OR labels != "${REVISIT_LABEL}")`;

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
      const jql = excludeOwnTickets(tripwire.jql);
      const count = await countIssues(requester, jql);
      const broken = count > threshold;
      return {
        ...assumption,
        status: broken ? 'broken' : 'holding',
        checkedAt,
        evidence: {
          summary: `${count} matching issue${count === 1 ? '' : 's'} (limit ${threshold})`,
          issues: broken ? await sampleIssues(requester, jql) : [],
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

    if (tripwire.type === 'alert') {
      // State is pushed in by the monitoring webhook (src/webhook.js); here we only read it.
      const alert = assumption.alert;
      const firing = alert?.state === 'firing';
      return {
        ...assumption,
        status: firing ? 'broken' : 'holding',
        checkedAt,
        evidence: {
          summary: !alert
            ? 'Waiting for monitoring alerts'
            : firing
              ? `Alert firing: ${alert.name} (since ${new Date(alert.at).toUTCString()}, via ${alert.source})`
              : `Alert resolved: ${alert.name} (${new Date(alert.at).toUTCString()})`,
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
        try {
          after.ticket = await createRevisitTicket(requester, record, after);
          after.ticketError = null;
        } catch (e) {
          after.ticket = null;
          after.ticketError = e.message;
        }
      }
    } else if (after.status === 'holding') {
      // Recovered: the next break gets a fresh ticket.
      after.ticket = null;
      after.ticketError = null;
    } else {
      after.ticket = before.ticket || null;
    }
    assumptions.push(after);
  }
  const brokenCount = assumptions.filter((a) => a.status === 'broken').length;
  return { ...record, assumptions, brokenCount, lastCheckedAt: new Date().toISOString() };
}
