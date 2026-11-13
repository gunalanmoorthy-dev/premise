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

// Developer-only backtest: real ADRs that their teams later superseded.
const Backtest = () => {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [res, setRes] = useState(null);
  const [note, setNote] = useState(null);

  const load = async () => setRes(await invoke('backtestResults'));

  const runAll = async () => {
    setBusy(true);
    setNote(null);
    try {
      const total = await invoke('backtestSize');
      const done = new Set(((await invoke('backtestResults')).results || []).map((r) => r.id));
      for (let id = 1; id <= total; id += 1) {
        if (done.has(id)) continue;
        setProgress(`Running pair ${id} of ${total}...`);
        try {
          await invoke('backtestRun', { id });
        } catch (e) {
          setNote(`Pair ${id} failed: ${e.message}`);
        }
      }
      setProgress(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');

  return (
    <Box padding="space.150" backgroundColor="color.background.neutral">
      <Stack space="space.100">
        <Heading size="small">Backtest (development only)</Heading>
        <Text size="small">
          37 real architecture decisions from 31 public GitHub repos that their own teams later
          superseded. Premise extracts assumptions from each old decision only; a judge reads the
          replacement and checks whether the condition that changed was already on Premise's list.
        </Text>
        <Inline space="space.100">
          <LoadingButton isLoading={busy} isDisabled={busy} onClick={runAll}>Run backtest</LoadingButton>
          <LoadingButton isDisabled={busy} onClick={load}>Show results</LoadingButton>
          <LoadingButton isDisabled={busy}
            onClick={async () => { const r = await invoke('backtestClear'); setRes(null); setNote(`Cleared ${r.deleted} results.`); }}>
            Clear
          </LoadingButton>
        </Inline>
        {progress && <Text size="small">{progress}</Text>}
        {note && <Text size="small">{note}</Text>}
        {res && (
          <Stack space="space.075">
            <Text>
              <Strong>
                Caught {res.caught} of {res.eligible} ({pct(res.caught, res.eligible)})
              </Strong>{' '}
              superseded decisions: the condition that later changed was already one of Premise's
              assumptions. {res.caughtWatchable} of those also had a tripwire suggested.
              ({res.run} of {res.total} pairs run; {res.run - res.eligible} excluded because the
              replacement named no changed condition.)
            </Text>
            {res.results.map((r) => (
              <Text key={r.id} size="small">
                {r.matched ? 'CAUGHT' : r.changedCondition && r.replaced ? 'MISSED' : 'EXCLUDED'} #{r.id} {r.repo}:{' '}
                {r.changedCondition || 'no changed condition'}
                {r.matched ? ` -> "${r.matched}"` : ''}
              </Text>
            ))}
          </Stack>
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
  const [bulk, setBulk] = useState(null);

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

  // One-click setup: track every decision Premise found, in one pass.
  const trackAll = async () => {
    const list = data?.discovered || [];
    setMessage(null);
    setError(null);
    setBulk({ done: 0, total: list.length });
    let tracked = 0;
    let skipped = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        const result = await invoke('trackPage', { pageId: list[i].pageId });
        result.tracked ? (tracked += 1) : (skipped += 1);
      } catch (e) {
        skipped += 1;
      }
      setBulk({ done: i + 1, total: list.length });
    }
    setBulk(null);
    setMessage(
      `Now tracking ${tracked} ${tracked === 1 ? 'decision' : 'decisions'}` +
        (skipped ? `. ${skipped} had no assumptions Premise could read.` : '.')
    );
    await load();
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

      {tracked.length === 0 && discovered.length > 0 && !bulk && (
        <SectionMessage appearance="information" title="Set Premise up in one click">
          <Stack space="space.150">
            <Text>
              Premise found <Strong>{discovered.length}</Strong>{' '}
              {discovered.length === 1 ? 'decision page' : 'decision pages'} on this site. Track them all
              and it reads the assumptions behind each one, proposes a tripwire for every assumption, and
              starts watching straight away.
            </Text>
            <Inline>
              <LoadingButton appearance="primary" isLoading={false} isDisabled={busyId !== null} onClick={trackAll}>
                Track all {discovered.length}
              </LoadingButton>
            </Inline>
          </Stack>
        </SectionMessage>
      )}
      {bulk && (
        <SectionMessage appearance="information" title="Setting up">
          <Text>
            Reading decision {bulk.done + (bulk.done < bulk.total ? 1 : 0)} of {bulk.total}. This takes a few
            seconds per page.
          </Text>
        </SectionMessage>
      )}

      {/* Summary line */}
      <Inline space="space.200">
        <Text>
          <Strong>{tracked.length}</Strong> {tracked.length === 1 ? 'decision' : 'decisions'} tracked
        </Text>
        <Text>
          <Strong>{brokenTotal}</Strong> broken {brokenTotal === 1 ? 'assumption' : 'assumptions'}
        </Text>
        <Text>
          <Strong>{discovered.length}</Strong> untracked {discovered.length === 1 ? 'decision' : 'decisions'} found
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
        {discovered.length > 1 && tracked.length > 0 && !bulk && (
          <Inline>
            <LoadingButton appearance="primary" isLoading={false} isDisabled={busyId !== null} onClick={trackAll}>
              Track all {discovered.length}
            </LoadingButton>
          </Inline>
        )}
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
      {isDev && <Backtest />}
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
