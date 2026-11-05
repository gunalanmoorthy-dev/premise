// Backend for the Premise byline panel.
// The frontend calls these functions with invoke('<name>', payload).

import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { chat, list } from '@forge/llm';

const resolver = new Resolver();

// Preferred Claude model. If Forge does not offer it, pickModel() falls back
// to an active Sonnet (or any active model) from Forge's own model list.
const PREFERRED_MODEL = 'claude-sonnet-5';
let cachedModel = null;

async function pickModel() {
  if (cachedModel) return cachedModel;
  try {
    const { models } = await list();
    const active = models.filter((m) => m.status === 'active').map((m) => m.model);
    cachedModel =
      active.find((m) => m === PREFERRED_MODEL) ||
      active.find((m) => m.includes('sonnet')) ||
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
  return {
    title: page.title,
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
    'For each one, suggest how it could be watched in Jira or by date, in one short line.',
    '',
    'Reply with JSON only, in exactly this shape:',
    '{"decision": "one sentence or null", "assumptions": [{"text": "...", "watchHint": "..."}]}',
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
    })).filter((a) => a.text),
  };
});

// 2. Save the assumptions the user confirmed for this page.
resolver.define('saveAssumptions', async ({ payload, context }) => {
  const { pageId, decision, assumptions } = payload;
  const record = {
    pageId,
    decision,
    assumptions,
    savedBy: context.accountId,
    savedAt: new Date().toISOString(),
  };
  await kvs.set(storageKey(pageId), record);
  return record;
});

// 3. Load what was saved before, so the panel shows it straight away.
resolver.define('getSaved', async ({ payload }) => {
  return (await kvs.get(storageKey(payload.pageId))) || null;
});

export const handler = resolver.getDefinitions();
