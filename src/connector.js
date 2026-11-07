// Teamwork Graph connector: writes each tracked decision into the graph as a
// document object, so decisions become first-class in Atlassian's graph
// (searchable by Rovo and readable by other apps).

import { kvs } from '@forge/kvs';
import { graph } from '@forge/teamwork-graph';

const CONNECTION_KEY = 'premise-graph-connection';

// Called by Atlassian when an admin connects, edits or removes the connector.
export async function onConnectionChange(event) {
  const e = event?.body || event || {};
  console.log(`Premise connector event: ${JSON.stringify({ action: e.action, connectionId: e.connectionId, keys: Object.keys(event || {}) })}`);
  if (e.action === 'DELETED') {
    await kvs.delete(CONNECTION_KEY);
    console.log('Premise connector disconnected');
  } else if (e.connectionId) {
    await kvs.set(CONNECTION_KEY, { connectionId: e.connectionId, name: e.name || null });
    console.log(`Premise connector ${e.action || 'CREATED'}: ${e.connectionId}`);
  }
  return { statusCode: 200 };
}

const STATUS_WORD = { holding: 'Holding', broken: 'BROKEN', unwatched: 'Not watched', error: 'Check failed' };

// Build the graph document for one decision record.
function toDocument(record) {
  const now = new Date().toISOString();
  const broken = record.assumptions.filter((a) => a.status === 'broken').length;
  const lines = [
    `Decision: ${record.decision || record.pageTitle}`,
    `Health: ${broken > 0 ? `${broken} broken assumption(s)` : 'all assumptions holding'}`,
    '',
    'Assumptions:',
    ...record.assumptions.map(
      (a) =>
        `- [${STATUS_WORD[a.status] || 'Not watched'}] ${a.text}` +
        (a.evidence?.summary ? ` (${a.evidence.summary})` : '') +
        (a.ticket?.key ? ` Revisit ticket: ${a.ticket.key}` : '')
    ),
  ];
  return {
    schemaVersion: '1.0',
    id: `premise-decision-${record.pageId}`,
    updateSequenceNumber: Date.now(),
    displayName: `Decision: ${String(record.pageTitle || record.decision).replace(/^decision:\s*/i, '')}`,
    description: `${broken > 0 ? 'At risk' : 'Holding'}: ${record.decision || ''}`.slice(0, 250),
    url: record.pageUrl,
    createdAt: record.savedAt || now,
    lastUpdatedAt: record.lastCheckedAt || now,
    permissions: [{ accessControls: [{ principals: [{ type: 'EVERYONE' }] }] }],
    'atlassian:document': {
      type: { category: 'DOCUMENT', mimeType: 'text/plain' },
      content: { mimeType: 'text/plain', text: lines.join('\n') },
      labels: ['premise-decision', broken > 0 ? 'premise-broken' : 'premise-holding'],
    },
  };
}

// Write one decision into the graph. Never throws: a graph problem must not
// break saving or checking. Returns a small status object for the record.
export async function syncDecisionToGraph(record) {
  try {
    if (!record?.pageUrl) return { ok: false, reason: 'no page URL yet' };
    const conn = await kvs.get(CONNECTION_KEY);
    if (!conn?.connectionId) return { ok: false, reason: 'connector not connected' };
    const res = await graph.setObjects({ connectionId: conn.connectionId, objects: [toDocument(record)] });
    if (!res?.success) return { ok: false, reason: String(res?.error || 'setObjects failed').slice(0, 200) };
    const rejected = res.results?.rejected || [];
    if (rejected.length) return { ok: false, reason: JSON.stringify(rejected).slice(0, 200) };
    return { ok: true, at: new Date().toISOString() };
  } catch (e) {
    console.warn(`Teamwork Graph write failed for page ${record?.pageId}: ${e.message}`);
    return { ok: false, reason: e.message.slice(0, 200) };
  }
}
