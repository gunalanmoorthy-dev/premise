// Tripwire engine: decides whether each saved assumption still holds.
// Used by the "Check now" button (as the user) and the hourly check (as the app).

import { route } from '@forge/api';

// How many matching issues to show as evidence when a wire trips.
const SAMPLE_SIZE = 5;

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
      const count = await countIssues(requester, tripwire.jql);
      const broken = count > threshold;
      return {
        ...assumption,
        status: broken ? 'broken' : 'holding',
        checkedAt,
        evidence: {
          summary: `${count} matching issue${count === 1 ? '' : 's'} (limit ${threshold})`,
          issues: broken ? await sampleIssues(requester, tripwire.jql) : [],
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

// Check every assumption in one page record.
export async function checkRecord(requester, record) {
  const assumptions = [];
  for (const a of record.assumptions || []) {
    assumptions.push(await checkAssumption(requester, a));
  }
  const brokenCount = assumptions.filter((a) => a.status === 'broken').length;
  return { ...record, assumptions, brokenCount, lastCheckedAt: new Date().toISOString() };
}
