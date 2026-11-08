// Scaling the tripwire check: instead of one long function walking every decision
// (which Forge would time out), the hourly job splits decisions into small batches
// and pushes them onto a queue. Forge runs the batches in parallel workers.
// Also holds the developer-only scale test (500 synthetic tripwires).

import api from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { Queue } from '@forge/events';
import { checkSyncStore } from './resolvers';

const PAGE_PREFIX = 'premise-page-';
const SCALE_PREFIX = 'premise-page-lt-';   // synthetic scale-test decisions
const RUN_PREFIX = 'premise-run-';         // one key per run (start time, batch count)
const BATCH_PREFIX = 'premise-runbatch-';  // one key per finished batch (timing)
const BATCH_SIZE = 5;                      // decisions per worker, keeps each well under the time limit
const MAX_PUSH = 50;                       // Forge limit: events per push

const queue = new Queue({ key: 'premise-check-queue' });

// All keys starting with a prefix (values are skipped by the caller if not needed).
async function keysWithPrefix(prefix) {
  const keys = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const { results, nextCursor } = await q.getMany();
    keys.push(...results.map((r) => r.key));
    cursor = nextCursor;
  } while (cursor);
  return keys;
}

// Split every tracked decision into batches and queue them. Returns the run summary.
export async function enqueueChecks(runId) {
  const keys = await keysWithPrefix(PAGE_PREFIX);
  const batches = [];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) batches.push(keys.slice(i, i + BATCH_SIZE));

  await kvs.set(`${RUN_PREFIX}${runId}`, {
    runId,
    startedAt: new Date().toISOString(),
    decisions: keys.length,
    batches: batches.length,
  });

  const events = batches.map((batch, index) => ({ body: { runId, index, keys: batch } }));
  for (let i = 0; i < events.length; i += MAX_PUSH) {
    await queue.push(events.slice(i, i + MAX_PUSH));
  }
  console.log(`Premise check ${runId}: ${keys.length} decisions queued in ${batches.length} batches`);
  return { runId, decisions: keys.length, batches: batches.length };
}

// Queue worker: check one batch of decisions and record how long it took.
export async function checkBatchConsumer(event) {
  const { runId, index, keys } = event?.body || event?.payload || {};
  const started = Date.now();
  let decisions = 0;
  let assumptions = 0;
  let broken = 0;
  let errors = 0;

  for (const key of keys || []) {
    try {
      const value = await kvs.get(key);
      if (!value || !Array.isArray(value.assumptions)) continue;
      const checked = await checkSyncStore(api.asApp(), key, value);
      decisions += 1;
      assumptions += checked.assumptions.length;
      broken += checked.brokenCount;
      errors += checked.assumptions.filter((a) => a.status === 'error').length;
    } catch (e) {
      errors += 1;
      console.warn(`Premise check ${runId}: ${key} failed: ${e.message}`);
    }
  }

  const ms = Date.now() - started;
  await kvs.set(`${BATCH_PREFIX}${runId}-${index}`, {
    runId, index, decisions, assumptions, broken, errors, ms, endedAt: new Date().toISOString(),
  });
  console.log(`Premise check ${runId} batch ${index}: ${decisions} decisions, ${assumptions} tripwires, ${ms} ms`);
}

// Progress and timing of one run, built from the per-batch keys.
export async function runStatus(runId) {
  const run = await kvs.get(`${RUN_PREFIX}${runId}`);
  if (!run) return null;
  const done = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(`${BATCH_PREFIX}${runId}-`)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const { results, nextCursor } = await q.getMany();
    done.push(...results.map((r) => r.value));
    cursor = nextCursor;
  } while (cursor);
  const sum = (k) => done.reduce((n, b) => n + (b[k] || 0), 0);
  const lastEnd = done.reduce((t, b) => Math.max(t, Date.parse(b.endedAt)), 0);
  return {
    ...run,
    batchesDone: done.length,
    decisionsChecked: sum('decisions'),
    tripwiresChecked: sum('assumptions'),
    broken: sum('broken'),
    errors: sum('errors'),
    slowestBatchMs: done.reduce((m, b) => Math.max(m, b.ms || 0), 0),
    wallClockSeconds: lastEnd ? Math.round((lastEnd - Date.parse(run.startedAt)) / 1000) : null,
    finished: done.length >= run.batches,
  };
}

// Developer-only: create synthetic decisions, 4 real Jira-search tripwires each.
// They use a search that matches nothing, so they hold, open no tickets, and are
// never published to Teamwork Graph (see checkSyncStore).
export async function seedScaleTest(count = 125) {
  const now = new Date().toISOString();
  for (let i = 0; i < count; i += 1) {
    const assumptions = [0, 1, 2, 3].map((j) => ({
      id: `lt${i}-${j}`,
      text: `Scale test assumption ${j + 1}`,
      tripwire: { type: 'jql', jql: `text ~ "premise-scale-test-${(i * 4 + j) % 50}" AND created >= -30d`, threshold: 5 },
    }));
    await kvs.set(`${SCALE_PREFIX}${i}`, {
      pageId: `lt-${i}`,
      pageTitle: `Scale test decision ${i + 1}`,
      decision: `Scale test decision ${i + 1}`,
      synthetic: true,
      ticketProjectKey: null,
      assumptions,
      savedAt: now,
    });
  }
  return { decisions: count, tripwires: count * 4 };
}

// Developer-only: remove synthetic decisions and old run records.
export async function cleanScaleTest() {
  const keys = [
    ...(await keysWithPrefix(SCALE_PREFIX)),
    ...(await keysWithPrefix(RUN_PREFIX)),
    ...(await keysWithPrefix(BATCH_PREFIX)),
  ];
  for (const key of keys) await kvs.delete(key);
  return { deleted: keys.length };
}
