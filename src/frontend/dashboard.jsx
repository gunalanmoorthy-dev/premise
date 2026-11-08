// Premise dashboard (UI Kit): Confluence sidebar > Apps > Premise.
// Shows every tracked decision with its health, plus decision pages Premise found
// that nobody is tracking yet, each with a one-click Track button.

import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Heading,
  Inline,
  Link,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Stack,
  Strong,
  Text,
  useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// Health label for one tracked decision.
const health = (d) => {
  if (d.broken > 0) return { appearance: 'removed', label: `${d.broken} broken` };
  if (d.watched === 0) return { appearance: 'default', label: 'Not watched' };
  return { appearance: 'success', label: 'Holding' };
};

const PageLink = ({ url, title }) => (url ? <Link href={url}>{title}</Link> : <Text>{title}</Text>);


// Developer-only scale test: 125 synthetic decisions x 4 tripwires = 500 tripwires,
// checked through the same queued path as the hourly job.
const ScaleTest = () => {
  const [busy, setBusy] = useState(null);
  const [runId, setRunId] = useState(null);
  const [status, setStatus] = useState(null);
  const [note, setNote] = useState(null);

  const step = (name, fn) => async () => {
    setBusy(name);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(`Failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const refresh = async (id = runId) => id && setStatus(await invoke('scaleStatus', { runId: id }));

  return (
    <Box padding="space.150" backgroundColor="color.background.neutral">
      <Stack space="space.100">
        <Heading size="small">Scale test (development only)</Heading>
        <Text size="small">
          Creates 125 test decisions with 500 Jira-search tripwires, runs the hourly check on them
          through the batch queue, and reports the timing. Test decisions are hidden from this
          dashboard and never published to Teamwork Graph.
        </Text>
        <Inline space="space.100">
          <LoadingButton isLoading={busy === 'seed'} isDisabled={!!busy}
            onClick={step('seed', async () => { const r = await invoke('scaleSeed'); setNote(`Created ${r.decisions} decisions, ${r.tripwires} tripwires.`); })}>
            1. Create 500 tripwires
          </LoadingButton>
          <LoadingButton isLoading={busy === 'run'} isDisabled={!!busy}
            onClick={step('run', async () => { const r = await invoke('scaleRun'); setRunId(r.runId); setStatus(null); setNote(`Queued ${r.decisions} decisions in ${r.batches} batches.`); })}>
            2. Run check
          </LoadingButton>
          <LoadingButton isLoading={busy === 'refresh'} isDisabled={!!busy || !runId}
            onClick={step('refresh', () => refresh())}>
            3. Refresh results
          </LoadingButton>
          <LoadingButton isLoading={busy === 'clean'} isDisabled={!!busy}
            onClick={step('clean', async () => { const r = await invoke('scaleClean'); setRunId(null); setStatus(null); setNote(`Removed ${r.deleted} test records.`); })}>
            4. Clean up
          </LoadingButton>
        </Inline>
        {note && <Text size="small">{note}</Text>}
        {status && (
          <Text size="small">
            {status.finished ? 'Finished' : 'Running'}: {status.batchesDone} of {status.batches} batches,{' '}
            {status.decisionsChecked} decisions and {status.tripwiresChecked} tripwires checked,{' '}
            {status.errors} errors, slowest batch {(status.slowestBatchMs / 1000).toFixed(1)} s
            {status.wallClockSeconds !== null ? `, total ${status.wallClockSeconds} s from start to last batch` : ''}.
          </Text>
        )}
      </Stack>
    </Box>
  );
};

const App = () => {
  const context = useProductContext();
  const isDev = context?.environmentType === 'DEVELOPMENT';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);

  const load = () =>
    invoke('listDecisions')
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const track = async (page) => {
    setBusyId(page.pageId);
    setMessage(null);
    setError(null);
    try {
      const result = await invoke('trackPage', { pageId: page.pageId });
      setMessage(
        result.tracked
          ? `Now tracking "${page.title}": ${result.total} assumptions, ${result.broken} broken.`
          : `"${page.title}": ${result.note}`
      );
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!data && !error) return <Text>Loading decisions...</Text>;

  const tracked = data?.tracked || [];
  const discovered = data?.discovered || [];
  const brokenTotal = tracked.reduce((n, d) => n + d.broken, 0);

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading size="large">Premise</Heading>
        <Text>Every decision rests on assumptions. Premise watches them and tells you when one breaks.</Text>
      </Stack>

      {error && (
        <SectionMessage appearance="error" title="Something went wrong">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {message && (
        <SectionMessage appearance="success" title="Done">
          <Text>{message}</Text>
        </SectionMessage>
      )}

      {/* Summary line */}
      <Inline space="space.200">
        <Text>
          <Strong>{tracked.length}</Strong> decisions tracked
        </Text>
        <Text>
          <Strong>{brokenTotal}</Strong> broken assumptions
        </Text>
        <Text>
          <Strong>{discovered.length}</Strong> untracked decisions found
        </Text>
      </Inline>

      {/* Tracked decisions */}
      <Stack space="space.150">
        <Heading size="medium">Tracked decisions</Heading>
        {tracked.length === 0 ? (
          <Text>Nothing tracked yet. Track one of the decisions found below.</Text>
        ) : (
          tracked.map((d) => {
            const h = health(d);
            return (
              <Box key={d.pageId} padding="space.150" backgroundColor="color.background.neutral.subtle">
                <Stack space="space.075">
                  <Inline space="space.100" alignBlock="center">
                    <Lozenge appearance={h.appearance}>{h.label}</Lozenge>
                    <PageLink url={d.url} title={d.title} />
                  </Inline>
                  {d.decision && <Text size="small">{d.decision}</Text>}
                  {d.broken > 0 && (d.people || d.dependents) && (
                    <Text size="small">
                      <Strong>Affects:</Strong>{' '}
                      {(d.people || []).length} {(d.people || []).length === 1 ? 'person' : 'people'}
                      {(d.people || []).length ? ` (${d.people.map((u) => u.name).join(', ')})` : ''}
                      {', '}
                      {(d.dependents || []).length} decision{(d.dependents || []).length === 1 ? '' : 's'} built on it
                      {(d.dependents || []).length ? ` (${d.dependents.map((p) => p.title).join(', ')})` : ''}
                      {d.graphSource === 'teamwork-graph' ? ' (Teamwork Graph)' : ''}
                    </Text>
                  )}
                  <Text size="small">
                    {d.total} assumptions, {d.watched} watched
                    {d.tickets.length > 0 ? `, revisit tickets: ${d.tickets.join(', ')}` : ''}
                    {d.lastCheckedAt ? `, last checked ${new Date(d.lastCheckedAt).toLocaleString()}` : ''}
                  </Text>
                </Stack>
              </Box>
            );
          })
        )}
      </Stack>

      {/* Discovered, not tracked */}
      <Stack space="space.150">
        <Heading size="medium">Decisions found, not tracked yet</Heading>
        <Text size="small">
          Pages whose title mentions a decision or ADR, or whose text says "we decided" or "decided to".
        </Text>
        {data?.discoverError && <Text>Search failed: {data.discoverError}</Text>}
        {discovered.length === 0 ? (
          <Text>No untracked decisions found.</Text>
        ) : (
          discovered.map((p) => (
            <Inline key={p.pageId} space="space.150" alignBlock="center" spread="space-between">
              <PageLink url={p.url} title={p.title} />
              <LoadingButton
                appearance="primary"
                isLoading={busyId === p.pageId}
                isDisabled={busyId !== null && busyId !== p.pageId}
                onClick={() => track(p)}
              >
                Track
              </LoadingButton>
            </Inline>
          ))
        )}
      </Stack>
      {isDev && <ScaleTest />}
    </Stack>
  );
};

// Safety net: show crash text instead of a blank page.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <SectionMessage appearance="error" title="Premise dashboard hit an error">
          <Text>{String(this.state.error?.message || this.state.error)}</Text>
        </SectionMessage>
      );
    }
    return this.props.children;
  }
}

ForgeReconciler.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
