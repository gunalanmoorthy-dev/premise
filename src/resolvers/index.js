// Backend for the Premise byline panel.
// The frontend calls these functions with invoke('<name>', payload).

import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { checkRecord } from '../tripwires';
import { decisionContext, linkedPagesOf } from '../graph';
import { syncDecisionToGraph } from '../connector';

// Check a record, write the result into the Teamwork Graph, then store it.
async function checkSyncStore(requester, key, record) {
  const checked = await checkRecord(requester, record);
  checked.graphSync = await syncDecisionToGraph(checked);
  await kvs.set(key, checked);
  return checked;
}
import { chat, list } from '@forge/llm';

const resolver = new Resolver();

// Preferred Claude model. If Forge does not offer it, pickModel() falls back
// to an active Sonnet (or any active model) from Forge's own model list.
const PREFERRED_MODEL = 'claude-haiku-4-5';
let cachedModel = null;

async function pickModel() {
  if (cachedModel) return cachedModel;
  try {
    const { models } = await list();
    const active = models.filter((m) => m.status === 'active').map((m) => m.model);
    cachedModel =
      active.find((m) => m === PREFERRED_MODEL) ||
      active.find((m) => m.includes('haiku')) ||
      active[0] ||
      PREFERRED_MODEL;
  } catch (e) {
    console.warn(`Could not list Forge LLM models, using ${PREFERRED_MODEL}: ${e.message}`);
    cachedModel = PREFERRED_MODEL;
  }
  console.log(`Premise is using model: ${cachedModel}`);
  return cachedModel;
}

// Longest page text we send to the model (keeps cost and latency down).
const MAX_PAGE_CHARS = 12000;

// Storage key for one page's saved assumptions.
const storageKey = (pageId) => `premise-page-${pageId}`;

// Turn Confluence storage-format HTML into plain text for the model.
function htmlToText(html) {
  return html
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Read the page as the current user, so Premise only sees what they can see.
async function fetchPage(pageId) {
  const res = await api
    .asUser()
    .requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) {
    throw new Error(`Could not read page ${pageId} (HTTP ${res.status})`);
  }
  const page = await res.json();
  const base = page._links?.base || '';
  const webui = page._links?.webui || '';
  return {
    title: page.title,
    url: webui ? `${base}${webui}` : null,
    text: htmlToText(page.body?.storage?.value || ''),
  };
}

// Pull the first JSON object out of the model's reply, even if it adds extra words.
function parseJson(reply) {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('The model did not return JSON');
  }
  return JSON.parse(reply.slice(start, end + 1));
}

// 1. Ask Claude to find the decision on the page and the assumptions it rests on.
async function extractForPage(pageId) {
  const page = await fetchPage(pageId);

  if (page.text.length < 40) {
    return { decision: null, assumptions: [], note: 'This page has too little text to analyse.' };
  }

  const prompt = [
    'You read a Confluence page and find the main decision it records,',
    'plus the assumptions that decision depends on.',
    'An assumption is something that must stay true for the decision to stay right,',
    'for example a traffic level, a cost limit, a vendor promise, a deadline or a team size.',
    'Only list assumptions the page states or clearly implies. Do not invent any.',
    'Write each assumption about the team\'s own situation and numbers, so it can be measured,',
    'for example "Orders traffic stays under 1,000 requests per second".',
    'Never write an assumption about whether a technology is good or can scale',
    '(not "Postgres can handle our load"): decisions are not wrong, they expire when',
    'the conditions they were made under change.',
    'Describe the decision the same way: the setup chosen for today\'s conditions,',
    'for example "Run orders on a single Postgres instance with no replicas".',
    'Return 0 to 6 assumptions.',
    'For each one, also propose a tripwire that would show the assumption has broken:',
    '- type "jql": a Jira JQL search plus a threshold. The wire trips when MORE issues than the threshold match.',
    '  Use only portable JQL: text ~ "keyword", created >= -30d, statusCategory != Done, labels = x.',
    '  Do not guess project keys or custom issue types. Set the threshold as an early warning,',
    '  so the wire trips slightly before the real limit is reached.',
    '- type "date": a YYYY-MM-DD date, when the assumption is tied to a deadline or renewal.',
    '- type "none": when it cannot be watched from Jira or a date.',
    'Also give watchHint: one short line, in plain words, explaining what the tripwire watches.',
    '',
    'Reply with JSON only, in exactly this shape:',
    '{"decision": "one sentence or null", "assumptions": [{"text": "...", "watchHint": "...",',
    ' "tripwire": {"type": "jql", "jql": "...", "threshold": 3} }]}',
    '',
    `Page title: ${page.title}`,
    'Page text:',
    page.text.slice(0, MAX_PAGE_CHARS),
  ].join('\n');

  const response = await chat({
    model: await pickModel(),
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: 1200,
  });

  const content = response.choices?.[0]?.message?.content;
  const reply = Array.isArray(content)
    ? content.map((part) => part.text || '').join('')
    : content || '';

  const result = parseJson(reply);
  return {
    decision: result.decision || null,
    assumptions: (result.assumptions || []).map((a, i) => ({
      id: `a${Date.now()}-${i}`,
      text: String(a.text || '').trim(),
      watchHint: String(a.watchHint || '').trim(),
      tripwire: normaliseTripwire(a.tripwire),
    })).filter((a) => a.text),
  };
}

resolver.define('extractAssumptions', async ({ payload }) => extractForPage(payload.pageId));

// Clean up a tripwire from the model or the panel into one safe shape.
function normaliseTripwire(t) {
  if (t?.type === 'jql' && String(t.jql || '').trim()) {
    return { type: 'jql', jql: String(t.jql).trim(), threshold: Math.max(0, Number(t.threshold) || 0) };
  }
  if (t?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || ''))) {
    return { type: 'date', date: String(t.date) };
  }
  return { type: 'none' };
}

// 2. Save the assumptions the user confirmed, then check them straight away.
async function saveForPage({ pageId, decision, assumptions, ticketProjectKey, accountId }) {
  const page = await fetchPage(pageId);
  const record = {
    pageId,
    pageTitle: page.title,
    pageUrl: page.url,
    ticketProjectKey: String(ticketProjectKey || '').trim().toUpperCase() || null,
    decision,
    assumptions: assumptions.map((a) => ({ ...a, tripwire: normaliseTripwire(a.tripwire) })),
    savedBy: accountId,
    savedAt: new Date().toISOString(),
  };
  return checkSyncStore(api.asUser(), storageKey(pageId), record);
}

resolver.define('saveAssumptions', async ({ payload, context }) =>
  saveForPage({ ...payload, accountId: context.accountId })
);

// Read every tracked decision record from storage.
async function allRecords() {
  const records = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith('premise-page-')).limit(20);
    if (cursor) query = query.cursor(cursor);
    const { results, nextCursor } = await query.getMany();
    for (const { value } of results) {
      if (value && Array.isArray(value.assumptions)) records.push(value);
    }
    cursor = nextCursor;
  } while (cursor);
  return records;
}

// Find likely decision pages the current user can see (Confluence CQL search).
const DECISION_CQL =
  'type = page AND (title ~ "decision" OR title ~ "ADR" OR text ~ "\\"we decided\\"" OR text ~ "\\"decided to\\"") order by lastmodified desc';

async function discoverPages() {
  const res = await api
    .asUser()
    .requestConfluence(route`/wiki/rest/api/search?cql=${DECISION_CQL}&limit=${25}`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) {
    throw new Error(`Confluence search failed (HTTP ${res.status}): ${(await res.text()).slice(0, 150)}`);
  }
  const data = await res.json();
  const base = data._links?.base || '';
  return (data.results || [])
    .filter((r) => r.content?.id)
    .map((r) => ({
      pageId: String(r.content.id),
      title: r.content.title || r.title,
      url: r.url ? `${base}${r.url}` : null,
      lastModified: r.lastModified || null,
    }));
}

// 3. Dashboard: tracked decisions plus newly discovered ones.
resolver.define('listDecisions', async ({ context }) => {
  const records = await allRecords();
  const trackedIds = new Set(records.map((r) => String(r.pageId)));
  const tracked = records
    .map((r) => ({
      pageId: String(r.pageId),
      title: r.pageTitle || r.decision || `Page ${r.pageId}`,
      url: r.pageUrl || null,
      decision: r.decision || null,
      total: r.assumptions.length,
      broken: r.assumptions.filter((a) => a.status === 'broken').length,
      watched: r.assumptions.filter((a) => a.tripwire && a.tripwire.type !== 'none').length,
      tickets: r.assumptions.map((a) => a.ticket?.key).filter(Boolean),
      lastCheckedAt: r.lastCheckedAt || null,
    }))
    .sort((x, y) => y.broken - x.broken);

  // For broken decisions only, ask the graph who and what they affect.
  const byId = new Map(records.map((r) => [String(r.pageId), r]));
  for (const d of tracked.filter((t) => t.broken > 0)) {
    try {
      const ctx = await contextWithCascade(context.cloudId, d.pageId, byId);
      d.people = [...new Map([...ctx.owners, ...ctx.contributors].map((u) => [u.accountId, u])).values()];
      d.linkedPages = ctx.linkedPages;
      d.dependents = ctx.dependents;
      d.graphSource = ctx.source;
    } catch (e) {
      d.graphError = e.message;
    }
  }

  let discovered = [];
  let discoverError = null;
  try {
    discovered = (await discoverPages()).filter((p) => !trackedIds.has(p.pageId));
  } catch (e) {
    discoverError = e.message;
  }
  return { tracked, discovered, discoverError };
});

// Cascade: graph context for a decision, with linked pages marked when they are
// tracked decisions too (they are at risk when this decision breaks).
async function contextWithCascade(cloudId, pageId, recordsById) {
  const ctx = await decisionContext(cloudId, pageId);
  const mark = (p) => {
    const r = recordsById.get(p.pageId);
    return {
      ...p,
      tracked: Boolean(r),
      broken: r ? r.assumptions.filter((a) => a.status === 'broken').length : 0,
    };
  };

  // Upstream: pages this decision builds on (its own outgoing links).
  const linkedPages = ctx.linkedPages.map(mark);

  // Downstream: tracked decisions that link TO this page. Graph links only point
  // outward, so ask each other tracked decision for its links (capped at 20).
  const dependents = [];
  if (ctx.source === 'teamwork-graph') {
    const others = [...recordsById.keys()].filter((id) => id !== String(pageId)).slice(0, 20);
    for (const id of others) {
      try {
        const links = await linkedPagesOf(cloudId, id);
        if (links.some((l) => l.pageId === String(pageId))) {
          const rec = recordsById.get(id);
          dependents.push(mark({ pageId: id, title: rec.pageTitle || rec.decision, url: rec.pageUrl || null }));
        }
      } catch (e) {
        console.warn(`Cascade: could not read links of page ${id}: ${e.message}`);
      }
    }
  }
  return { ...ctx, linkedPages, dependents };
}

// 3b. Panel: who is behind this decision and what depends on it.
resolver.define('decisionContext', async ({ payload, context }) => {
  const records = await allRecords();
  const byId = new Map(records.map((r) => [String(r.pageId), r]));
  const self = byId.get(String(payload.pageId));
  const ctx = await contextWithCascade(context.cloudId, String(payload.pageId), byId);
  const broken = self ? self.assumptions.filter((a) => a.status === 'broken').length : 0;
  return {
    ...ctx,
    atRisk: broken > 0 ? ctx.dependents : [],
  };
});

// 4. One-click "Track": extract assumptions and save them with suggested tripwires.
resolver.define('trackPage', async ({ payload, context }) => {
  const extracted = await extractForPage(payload.pageId);
  if (!extracted.assumptions || extracted.assumptions.length === 0) {
    return { tracked: false, note: extracted.note || 'No assumptions found on this page.' };
  }
  // Reuse the ticket project already chosen on another decision, if any.
  const existing = (await allRecords()).find((r) => r.ticketProjectKey);
  const record = await saveForPage({
    pageId: payload.pageId,
    decision: extracted.decision,
    assumptions: extracted.assumptions,
    ticketProjectKey: existing?.ticketProjectKey || null,
    accountId: context.accountId,
  });
  return { tracked: true, broken: record.brokenCount, total: record.assumptions.length };
});

// 2b. "Check now" button: re-run every tripwire on this page as the current user.
resolver.define('checkNow', async ({ payload }) => {
  const record = await kvs.get(storageKey(payload.pageId));
  if (!record || !Array.isArray(record.assumptions)) return null;
  return checkSyncStore(api.asUser(), storageKey(payload.pageId), record);
});

// 3. Load what was saved before, so the panel shows it straight away.
resolver.define('getSaved', async ({ payload }) => {
  const record = await kvs.get(storageKey(payload.pageId));
  // Return null unless the record has the shape the panel expects.
  return record && Array.isArray(record.assumptions) ? record : null;
});

export const handler = resolver.getDefinitions();

// Shared with the Rovo agent actions (src/agent.js).
export { allRecords, contextWithCascade, extractForPage, saveForPage, checkSyncStore, storageKey, discoverPages };

// Hourly job: re-check every page that has saved assumptions.
export async function scheduledCheck() {
  let cursor;
  let pages = 0;
  let broken = 0;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith('premise-page-')).limit(20);
    if (cursor) query = query.cursor(cursor);
    const { results, nextCursor } = await query.getMany();
    for (const { key, value } of results) {
      if (!value || !Array.isArray(value.assumptions)) continue;
      const checked = await checkSyncStore(api.asApp(), key, value);
      pages += 1;
      broken += checked.brokenCount;
    }
    cursor = nextCursor;
  } while (cursor);
  console.log(`Premise hourly check: ${pages} pages checked, ${broken} broken assumptions`);
}

// Byline label: Confluence calls this when a page loads.
// Shows "Premise: N broken" so people see trouble without opening the panel.
export async function bylineProps(event) {
  const pageId =
    event?.extension?.content?.id ||
    event?.context?.extension?.content?.id ||
    event?.contentId ||
    event?.context?.contentId;

  if (!pageId) {
    console.warn(`bylineProps: no page ID in event keys ${Object.keys(event || {}).join(',')}`);
    return { title: 'Premise', tooltip: 'Check the assumptions behind this decision' };
  }

  const record = await kvs.get(storageKey(pageId));
  if (!record || !Array.isArray(record.assumptions) || record.assumptions.length === 0) {
    return { title: 'Premise', tooltip: 'Check the assumptions behind this decision' };
  }

  const broken = record.assumptions.filter((a) => a.status === 'broken').length;
  const total = record.assumptions.length;
  if (broken > 0) {
    return {
      title: `Premise: ${broken} broken`,
      tooltip: `${broken} of ${total} assumptions behind this decision no longer hold`,
    };
  }
  return {
    title: `Premise: ${total} holding`,
    tooltip: `All ${total} assumptions behind this decision still hold`,
  };
}
