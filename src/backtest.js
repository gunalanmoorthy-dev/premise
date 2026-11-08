// Backtest: would Premise have caught real decisions before their teams replaced them?
//
// Dataset: 37 pairs of Architecture Decision Records from 31 public GitHub repos.
// Each pair is an ADR that its own team later marked "Superseded by" another ADR.
// (Same file-selection rule as the dataset behind Su et al. 2026 / Buchgeher et al.
// 2023: Markdown ADRs in adr/ or decisions/ folders.) Texts are bundled at deploy
// time from src/backtest/pairs.json (not committed; sources are in backtest-sources.json).
//
// For each pair:
//  1. Premise's real extraction (extractFromText) runs on the OLD decision only.
//  2. A judge reads the NEW decision and names the condition that changed, then says
//     whether any extracted assumption is that condition.
// Developer-only; results go to Forge storage.

import { chat } from '@forge/llm';
import { kvs, WhereConditions } from '@forge/kvs';
import pairs from './backtest/pairs.json';
import { extractFromText, pickModel } from './resolvers';

const RESULT_PREFIX = 'premise-backtest-';

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : {};
}

async function judge(pair, assumptions) {
  const list = assumptions.map((a, i) => `${i + 1}. ${a.text}`).join('\n') || '(none)';
  const prompt = [
    'You compare two architecture decision records from the same software project.',
    'OLD was later replaced by NEW. Decide:',
    '1. replaced: does NEW actually replace or revise the decision in OLD (not just move or rename the file)?',
    '2. changedCondition: the fact about the world, team, product or requirements that changed',
    '   and made OLD no longer right, as stated or clearly implied in NEW (or OLD\'s notes).',
    '   One short sentence. null if NEW only says it prefers another option with no changed condition.',
    '3. matchedAssumption: the number of the assumption in the list below that describes that same',
    '   condition (it would have been broken by the change). null if none matches. Be strict:',
    '   a match must be about the same condition, not just the same topic.',
    '',
    'Assumptions a tool extracted from OLD before it was replaced:',
    list,
    '',
    'Reply with JSON only: {"replaced": true, "changedCondition": "...", "matchedAssumption": 2, "why": "one sentence"}',
    '',
    `OLD (${pair.oldPath}):`,
    pair.old,
    '',
    `NEW (${pair.newPath}):`,
    pair.new,
  ].join('\n');

  const response = await chat({
    model: await pickModel(),
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: 400,
  });
  const content = response.choices?.[0]?.message?.content;
  const reply = Array.isArray(content) ? content.map((p) => p.text || '').join('') : content || '';
  return parseJson(reply);
}

export const backtestSize = () => pairs.length;

// Run one pair (one extraction + one judgement), store and return the result.
export async function runBacktestPair(id) {
  const pair = pairs.find((p) => p.id === Number(id));
  if (!pair) throw new Error(`No backtest pair ${id}`);
  const title = pair.oldPath.split('/').pop().replace(/\.md$/i, '');
  const extracted = await extractFromText(title, pair.old);
  const assumptions = extracted.assumptions || [];
  const verdict = await judge(pair, assumptions);
  const idx = Number(verdict.matchedAssumption);
  const matched = Number.isInteger(idx) && idx >= 1 && idx <= assumptions.length ? assumptions[idx - 1] : null;

  const result = {
    id: pair.id,
    repo: pair.repo,
    oldUrl: pair.oldUrl,
    newUrl: pair.newUrl,
    decision: extracted.decision,
    assumptions: assumptions.map((a) => ({ text: a.text, tripwire: a.tripwire?.type || 'none' })),
    replaced: verdict.replaced !== false,
    changedCondition: verdict.changedCondition || null,
    matched: matched ? matched.text : null,
    matchedWatchable: matched ? matched.tripwire?.type !== 'none' : false,
    why: verdict.why || null,
    at: new Date().toISOString(),
  };
  await kvs.set(`${RESULT_PREFIX}${pair.id}`, result);
  return result;
}

// All stored results plus the headline numbers.
export async function backtestResults() {
  const results = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(RESULT_PREFIX)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const { results: page, nextCursor } = await q.getMany();
    results.push(...page.map((r) => r.value));
    cursor = nextCursor;
  } while (cursor);
  results.sort((a, b) => a.id - b.id);

  // Eligible: really replaced, and the replacement names a condition that changed.
  const eligible = results.filter((r) => r.replaced && r.changedCondition);
  const caught = eligible.filter((r) => r.matched);
  return {
    total: pairs.length,
    run: results.length,
    eligible: eligible.length,
    caught: caught.length,
    caughtWatchable: caught.filter((r) => r.matchedWatchable).length,
    results,
  };
}

export async function clearBacktest() {
  const keys = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(RESULT_PREFIX)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const { results, nextCursor } = await q.getMany();
    keys.push(...results.map((r) => r.key));
    cursor = nextCursor;
  } while (cursor);
  for (const k of keys) await kvs.delete(k);
  return { deleted: keys.length };
}
