// Monitoring webhook: Datadog, Grafana or Prometheus Alertmanager call this URL
// (with ?token=<assumption token>) when an alert fires or resolves. The matching
// assumption turns Broken or Holding, and the usual revisit ticket and graph
// update follow. The URL comes from the "webhookUrl" resolver.

import api from '@forge/api';
import { allRecords, checkSyncStore, storageKey } from './resolvers';

const FIRING = ['firing', 'triggered', 're-triggered', 'alerting', 'alert', 'warn', 'warning', 'critical', 'error'];
const RESOLVED = ['resolved', 'recovered', 'ok', 'normal', 'no data', 'nodata'];

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify(body),
});

// Read the alert state and name from the common payload shapes.
//   Alertmanager / Grafana: { status: "firing"|"resolved", alerts: [{ labels: { alertname } }] }
//   Datadog (custom payload): { "status": "$ALERT_TRANSITION", "name": "$EVENT_TITLE" }
//   Anything else: { "status": "firing"|"resolved", "name": "..." }
export function parseAlert(body) {
  const raw = String(body?.status ?? body?.alert_transition ?? body?.state ?? '').trim().toLowerCase();
  const state = FIRING.includes(raw) ? 'firing' : RESOLVED.includes(raw) ? 'resolved' : null;
  const name =
    body?.commonLabels?.alertname ||
    body?.alerts?.[0]?.labels?.alertname ||
    body?.title ||
    body?.name ||
    body?.alert_title ||
    'monitoring alert';
  const source = body?.alerts ? (body?.orgId !== undefined ? 'Grafana' : 'Alertmanager') : body?.alert_transition ? 'Datadog' : 'webhook';
  return { state, name: String(name).slice(0, 200), source };
}

export async function alertWebhook(request) {
  const token = request?.queryParameters?.token?.[0];
  if (!token) return reply(400, { ok: false, error: 'Missing ?token= in the webhook URL.' });

  let body;
  try {
    body = JSON.parse(request.body || '{}');
  } catch {
    return reply(400, { ok: false, error: 'Body must be JSON.' });
  }
  const alert = parseAlert(body);
  if (!alert.state) {
    return reply(400, { ok: false, error: 'Unknown alert status. Send "firing" or "resolved".' });
  }

  // Find the assumption that owns this token.
  const record = (await allRecords()).find((r) =>
    r.assumptions.some((a) => a.tripwire?.type === 'alert' && a.tripwire.token === token)
  );
  if (!record) return reply(404, { ok: false, error: 'No assumption uses this token.' });

  const at = new Date().toISOString();
  record.assumptions = record.assumptions.map((a) =>
    a.tripwire?.type === 'alert' && a.tripwire.token === token ? { ...a, alert: { ...alert, at } } : a
  );

  // Same path as the hourly check: evaluate, open or clear tickets, publish to the graph.
  const checked = await checkSyncStore(api.asApp(), storageKey(record.pageId), record);
  const hit = checked.assumptions.find((a) => a.tripwire?.token === token);
  console.log(`Premise alert ${alert.state}: "${alert.name}" -> ${hit?.status} on page ${record.pageId}`);

  return reply(200, {
    ok: true,
    status: hit?.status,
    assumption: hit?.text,
    decision: checked.decision,
    decisionUrl: checked.pageUrl,
    revisitTicket: hit?.ticket?.key || null,
  });
}
