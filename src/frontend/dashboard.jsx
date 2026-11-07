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
} from '@forge/react';
import { invoke } from '@forge/bridge';

// Health label for one tracked decision.
const health = (d) => {
  if (d.broken > 0) return { appearance: 'removed', label: `${d.broken} broken` };
  if (d.watched === 0) return { appearance: 'default', label: 'Not watched' };
  return { appearance: 'success', label: 'Holding' };
};

const PageLink = ({ url, title }) => (url ? <Link href={url}>{title}</Link> : <Text>{title}</Text>);

const App = () => {
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
