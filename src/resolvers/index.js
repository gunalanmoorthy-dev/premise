// Backend for the Premise byline panel.
// The frontend calls these functions with invoke('<name>', payload).

import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { checkRecord } from '../tripwires';
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
resolver.define('extractAssumptions', async ({ payload }) => {
  const { pageId } = payload;
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
});

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
resolver.define('saveAssumptions', async ({ payload, context }) => {
  const { pageId, decision, assumptions, ticketProjectKey } = payload;
  const page = await fetchPage(pageId);
  const record = {
    pageId,
    pageTitle: page.title,
    pageUrl: page.url,
    ticketProjectKey: String(ticketProjectKey || '').trim().toUpperCase() || null,
    decision,
    assumptions: assumptions.map((a) => ({ ...a, tripwire: normaliseTripwire(a.tripwire) })),
    savedBy: context.accountId,
    savedAt: new Date().toISOString(),
  };
  const checked = await checkRecord(api.asUser(), record);
  await kvs.set(storageKey(pageId), checked);
  return checked;
});

// 2b. "Check now" button: re-run every tripwire on this page as the current user.
resolver.define('checkNow', async ({ payload }) => {
  const record = await kvs.get(storageKey(payload.pageId));
  if (!record || !Array.isArray(record.assumptions)) return null;
  const checked = await checkRecord(api.asUser(), record);
  await kvs.set(storageKey(payload.pageId), checked);
  return checked;
});

// 3. Load what was saved before, so the panel shows it straight away.
resolver.define('getSaved', async ({ payload }) => {
  const record = await kvs.get(storageKey(payload.pageId));
  // Return null unless the record has the shape the panel expects.
  return record && Array.isArray(record.assumptions) ? record : null;
});

export const handler = resolver.getDefinitions();

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
      const checked = await checkRecord(api.asApp(), value);
      await kvs.set(key, checked);
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
