// Rovo agent actions: let people ask Premise about decisions in chat.
// Each action returns plain data; the agent turns it into an answer.

import api from '@forge/api';
import { kvs } from '@forge/kvs';
import {
  allRecords,
  contextWithCascade,
  allSummaries,
  recordById,
  extractForPage,
  saveForPage,
  checkSyncStore,
  storageKey,
  discoverPages,
} from './resolvers';

const STATUS = { holding: 'holding', broken: 'BROKEN', unwatched: 'not watched', error: 'check failed' };

// Rovo passes inputs at the top level and where the user is in `context`.
const ctxOf = (payload) => payload?.context || {};
const cloudIdOf = (payload) => ctxOf(payload).cloudId;
const accountIdOf = (payload) =>
  ctxOf(payload).accountId || ctxOf(payload).principal?.accountId || payload?.accountId || null;
const currentPageId = (payload) => {
  const c = ctxOf(payload).confluence || {};
  return c.contentId || c.id || null;
};

// Turn "163845", a page URL, a title, or nothing (current page) into a page ID.
async function resolvePageId(payload, ref) {
  const text = String(ref || '').trim();
  if (/^\d+$/.test(text)) return { pageId: text };
  const fromUrl = text.match(/pages\/(\d+)/) || text.match(/pageId=(\d+)/);
  if (fromUrl) return { pageId: fromUrl[1] };
  if (!text) {
    const here = currentPageId(payload);
    return here ? { pageId: String(here) } : { error: 'Tell me which decision: a page title, link or ID.' };
  }
  // Match words against tracked decisions first, then discovered pages.
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const score = (title) => words.filter((w) => String(title || '').toLowerCase().includes(w)).length;
  const records = await allRecords();
  const best = records
    .map((r) => ({ pageId: String(r.pageId), s: Math.max(score(r.pageTitle), score(r.decision)) }))
    .sort((a, b) => b.s - a.s)[0];
  if (best && best.s > 0) return { pageId: best.pageId };
  try {
    const found = (await discoverPages()).map((p) => ({ ...p, s: score(p.title) })).sort((a, b) => b.s - a.s)[0];
    if (found && found.s > 0) return { pageId: found.pageId };
  } catch (e) {
    console.warn(`Agent: discovery failed: ${e.message}`);
  }
  return { error: `No decision page matches "${text}".` };
}

const assumptionView = (a) => ({
  assumption: a.text,
  status: STATUS[a.status] || 'not watched',
  evidence: a.evidence?.summary || null,
  evidenceIssues: (a.evidence?.issues || []).map((i) => `${i.key}: ${i.summary}`),
  watchedBy: a.tripwire?.type === 'jql' ? `Jira search: ${a.tripwire.jql} (limit ${a.tripwire.threshold})`
    : a.tripwire?.type === 'date' ? `Date: ${a.tripwire.date}` : 'not watched',
  revisitTicket: a.ticket?.key || null,
});

// Action 1: overview of every tracked decision, broken ones first.
export async function listDecisions(payload) {
  const onlyBroken = String(payload?.onlyBroken ?? '').toLowerCase() === 'true';
  // Read the summary index, then load full records only for broken decisions:
  // a holding decision needs no assumption detail.
  const summaries = await allSummaries();
  const byId = new Map(summaries.map((s) => [String(s.pageId), s]));
  const rows = [];
  for (const s of summaries) {
    if (onlyBroken && s.broken === 0) continue;
    const r = s.broken > 0 ? await recordById(s.pageId) : null;
    const broken = r ? r.assumptions.filter((a) => a.status === 'broken') : [];
    const row = {
      decision: s.decision || s.title,
      page: s.title,
      url: s.url,
      health: s.broken > 0 ? `${s.broken} broken of ${s.total}` : `all ${s.total} holding`,
      brokenAssumptions: broken.map(assumptionView),
      lastChecked: s.lastCheckedAt || null,
    };
    if (s.broken > 0 && cloudIdOf(payload)) {
      try {
        const ctx = await contextWithCascade(cloudIdOf(payload), String(s.pageId), byId);
        row.people = [...new Set([...ctx.owners, ...ctx.contributors].map((u) => u.name))];
        row.decisionsAtRisk = ctx.dependents.map((d) => d.title);
      } catch (e) {
        row.graphError = e.message;
      }
    }
    rows.push({ ...row, _broken: s.broken });
  }
  rows.sort((a, b) => b._broken - a._broken);
  rows.forEach((r) => delete r._broken);
  return {
    trackedCount: summaries.length,
    brokenDecisions: summaries.filter((s) => s.broken > 0).length,
    decisions: rows,
  };
}

// Action 2: full story of one decision, including what depends on it.
export async function explainDecision(payload) {
  const target = await resolvePageId(payload, payload?.decision);
  if (target.error) return { error: target.error };
  const record = await kvs.get(storageKey(target.pageId));
  if (!record || !Array.isArray(record.assumptions)) {
    return { tracked: false, pageId: target.pageId, note: 'Premise is not tracking this page yet. Ask me to track it.' };
  }
  const out = {
    tracked: true,
    decision: record.decision,
    page: record.pageTitle,
    url: record.pageUrl,
    assumptions: record.assumptions.map(assumptionView),
    lastChecked: record.lastCheckedAt || null,
    publishedToTeamworkGraph: record.graphSync?.ok ? record.graphSync.at : false,
  };
  if (cloudIdOf(payload)) {
    try {
      const records = await allRecords();
      const ctx = await contextWithCascade(cloudIdOf(payload), target.pageId, new Map(records.map((r) => [String(r.pageId), r])));
      out.people = [...new Set([...ctx.owners, ...ctx.contributors].map((u) => u.name))];
      out.buildsOn = ctx.linkedPages.map((p) => p.title);
      out.dependedOnBy = ctx.dependents.map((d) => `${d.title}${d.broken > 0 ? ' (also broken)' : ''}`);
    } catch (e) {
      out.graphError = e.message;
    }
  }
  return out;
}

// Action 3: re-run the tripwires right now.
export async function checkDecision(payload) {
  const target = await resolvePageId(payload, payload?.decision);
  if (target.error) return { error: target.error };
  const key = storageKey(target.pageId);
  const record = await kvs.get(key);
  if (!record || !Array.isArray(record.assumptions)) {
    return { tracked: false, note: 'Premise is not tracking this page yet. Ask me to track it.' };
  }
  const checked = await checkSyncStore(api.asUser(), key, record);
  return {
    decision: checked.decision,
    url: checked.pageUrl,
    broken: checked.brokenCount,
    total: checked.assumptions.length,
    assumptions: checked.assumptions.map(assumptionView),
    checkedAt: checked.lastCheckedAt,
  };
}

// Action 4: start tracking a decision page (extract assumptions and suggested tripwires).
export async function trackDecision(payload) {
  const target = await resolvePageId(payload, payload?.decision);
  if (target.error) return { error: target.error };
  const existing = await kvs.get(storageKey(target.pageId));
  if (existing && Array.isArray(existing.assumptions)) {
    return { alreadyTracked: true, decision: existing.decision, url: existing.pageUrl };
  }
  const extracted = await extractForPage(target.pageId);
  if (!extracted.assumptions || extracted.assumptions.length === 0) {
    return { tracked: false, note: extracted.note || 'No assumptions found on this page.' };
  }
  const withProject = (await allRecords()).find((r) => r.ticketProjectKey);
  const record = await saveForPage({
    pageId: target.pageId,
    decision: extracted.decision,
    assumptions: extracted.assumptions,
    ticketProjectKey: withProject?.ticketProjectKey || null,
    accountId: accountIdOf(payload),
  });
  return {
    tracked: true,
    decision: record.decision,
    url: record.pageUrl,
    assumptions: record.assumptions.map(assumptionView),
    broken: record.brokenCount,
  };
}
