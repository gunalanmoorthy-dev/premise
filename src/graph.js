// Teamwork Graph reads: who owns a decision, who worked on it, and which pages link to it.
// Runs as the current user (the graph only allows asUser). Falls back to the
// Confluence REST API if the graph call fails, so the panel always shows something.

import api, { route } from '@forge/api';

// Operation names must look like company_operation (3+ and 4+ characters).
const op = (name) => `premise_${name}`;

const pageAri = (cloudId, pageId) => `ari:cloud:confluence:${cloudId}:page/${pageId}`;

// One graph call. Treat it as a success only when there is data and no errors,
// because the graph can return HTTP 200 with an error inside.
async function twg(cloudId, name, query, variables) {
  const res = await api
    .asUser()
    .requestTeamworkGraph(query, variables, op(name), undefined, {
      'X-Query-Context': `ari:cloud:platform::site/${cloudId}`,
    });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; ').slice(0, 300));
  }
  if (!json.data) throw new Error(`Teamwork Graph returned no data (HTTP ${res.status})`);
  return json.data;
}

const USERS_QUERY = (field, name) => `query ${op(name)}($id: ID!) {
  ${field}(id: $id, first: 25) {
    edges { node { __typename ... on AtlassianUser { accountId name } } }
  }
}`;

const LINKED_QUERY = `query ${op('linkedpages')}($id: ID!) {
  confluencePageLinkedConfluencePages(id: $id, first: 25) {
    edges { node { __typename ... on ConfluencePage { pageId title webUrl } } }
  }
}`;

const nodes = (data, field) => (data?.[field]?.edges || []).map((e) => e.node).filter(Boolean);

const uniqueUsers = (list) => {
  const seen = new Map();
  for (const u of list) if (u?.accountId && !seen.has(u.accountId)) seen.set(u.accountId, u);
  return [...seen.values()].map((u) => ({ accountId: u.accountId, name: u.name || 'Unknown' }));
};

// Graph view of one decision page.
async function fromGraph(cloudId, pageId) {
  const id = pageAri(cloudId, pageId);
  const [owners, contributors, linked] = await Promise.all([
    twg(cloudId, 'owners', USERS_QUERY('confluencePageOwners', 'owners'), { id }),
    twg(cloudId, 'contributors', USERS_QUERY('confluencePageContributors', 'contributors'), { id }),
    twg(cloudId, 'linkedpages', LINKED_QUERY, { id }),
  ]);
  return {
    source: 'teamwork-graph',
    owners: uniqueUsers(nodes(owners, 'confluencePageOwners')),
    contributors: uniqueUsers(nodes(contributors, 'confluencePageContributors')),
    linkedPages: nodes(linked, 'confluencePageLinkedConfluencePages')
      .filter((p) => p.pageId && String(p.pageId) !== String(pageId))
      .map((p) => ({ pageId: String(p.pageId), title: p.title, url: p.webUrl || null })),
  };
}

// REST fallback: page owner and author only (no links).
async function fromRest(pageId) {
  const res = await api
    .asUser()
    .requestConfluence(route`/wiki/api/v2/pages/${pageId}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Confluence REST fallback failed (HTTP ${res.status})`);
  const page = await res.json();
  const ids = [...new Set([page.ownerId, page.authorId].filter(Boolean))];
  return {
    source: 'confluence-rest',
    owners: ids.map((accountId) => ({ accountId, name: 'Page owner' })),
    contributors: [],
    linkedPages: [],
  };
}

// Pages one decision page links to (graph links point outward only).
export async function linkedPagesOf(cloudId, pageId) {
  const data = await twg(cloudId, 'linkedpages', LINKED_QUERY, { id: pageAri(cloudId, pageId) });
  return nodes(data, 'confluencePageLinkedConfluencePages')
    .filter((p) => p.pageId)
    .map((p) => ({ pageId: String(p.pageId), title: p.title, url: p.webUrl || null }));
}

// Public: graph first, REST if the graph fails.
export async function decisionContext(cloudId, pageId) {
  try {
    return await fromGraph(cloudId, pageId);
  } catch (e) {
    console.warn(`Teamwork Graph failed for page ${pageId}, using REST: ${e.message}`);
    const fallback = await fromRest(pageId);
    return { ...fallback, graphError: e.message };
  }
}
