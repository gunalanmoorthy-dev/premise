// Premise panel (UI Kit). Opens from the byline item or the page's Apps menu.
// Flow: Extract assumptions -> confirm and set tripwires -> Save -> watch status.

import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  Checkbox,
  DatePicker,
  Heading,
  Inline,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Select,
  Stack,
  Strong,
  Text,
  Textfield,
  useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const TRIPWIRE_OPTIONS = [
  { label: 'Jira search', value: 'jql' },
  { label: 'Date', value: 'date' },
  { label: "Don't watch", value: 'none' },
];

// Status label shown next to each saved assumption.
const STATUS = {
  holding: { appearance: 'success', label: 'Holding' },
  broken: { appearance: 'removed', label: 'Broken' },
  unwatched: { appearance: 'default', label: 'Not watched' },
  error: { appearance: 'moved', label: 'Check failed' },
};

// Make sure every assumption has a tripwire object to edit.
const withTripwire = (a) => ({ ...a, tripwire: a.tripwire || { type: 'none' } });

// Editor for one assumption's tripwire inside the review step.
const TripwireEditor = ({ tripwire, onChange }) => {
  const selected = TRIPWIRE_OPTIONS.find((o) => o.value === tripwire.type) || TRIPWIRE_OPTIONS[2];
  return (
    <Stack space="space.075">
      <Select
        options={TRIPWIRE_OPTIONS}
        value={selected}
        onChange={(option) => onChange({ ...tripwire, type: option.value })}
      />
      {tripwire.type === 'jql' && (
        <Stack space="space.075">
          <Textfield
            placeholder='text ~ "orders" AND created >= -30d'
            value={tripwire.jql || ''}
            onChange={(e) => onChange({ ...tripwire, jql: e.target.value })}
          />
          <Inline space="space.100" alignBlock="center">
            <Text>Trips when more than</Text>
            <Textfield
              type="number"
              width={80}
              value={String(tripwire.threshold ?? 0)}
              onChange={(e) => onChange({ ...tripwire, threshold: Number(e.target.value) })}
            />
            <Text>issues match</Text>
          </Inline>
        </Stack>
      )}
      {tripwire.type === 'date' && (
        <DatePicker
          value={tripwire.date || ''}
          onChange={(value) => onChange({ ...tripwire, date: value })}
        />
      )}
    </Stack>
  );
};

const App = () => {
  const context = useProductContext();
  const pageId =
    context?.extension?.content?.id ||
    context?.extension?.contentId ||
    context?.contentId ||
    null;

  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [checked, setChecked] = useState({});

  const isRecord = (r) => r && Array.isArray(r.assumptions);

  useEffect(() => {
    if (!pageId) return;
    invoke('getSaved', { pageId })
      .then((record) => setSaved(isRecord(record) ? record : null))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [pageId]);

  // Run an async action with the shared busy and error handling.
  const run = async (fn) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const startDraft = (decision, assumptions, note, ticketProjectKey) => {
    const list = assumptions.map(withTripwire);
    setDraft({ decision, assumptions: list, note, ticketProjectKey: ticketProjectKey || '' });
    setChecked(Object.fromEntries(list.map((a) => [a.id, true])));
  };

  const extract = () =>
    run(async () => {
      const result = await invoke('extractAssumptions', { pageId });
      startDraft(
        result?.decision,
        Array.isArray(result?.assumptions) ? result.assumptions : [],
        result?.note,
        saved?.ticketProjectKey
      );
    });

  const updateTripwire = (id, tripwire) =>
    setDraft({
      ...draft,
      assumptions: draft.assumptions.map((a) => (a.id === id ? { ...a, tripwire } : a)),
    });

  const save = () =>
    run(async () => {
      const record = await invoke('saveAssumptions', {
        pageId,
        decision: draft.decision,
        assumptions: draft.assumptions.filter((a) => checked[a.id]),
        ticketProjectKey: draft.ticketProjectKey,
      });
      setSaved(isRecord(record) ? record : null);
      setDraft(null);
    });

  const checkNow = () =>
    run(async () => {
      const record = await invoke('checkNow', { pageId });
      if (isRecord(record)) setSaved(record);
    });

  if (!context) return <Text>Loading Premise...</Text>;
  if (!pageId) {
    return (
      <SectionMessage appearance="warning" title="Premise could not find the page ID">
        <Text>{JSON.stringify(context.extension || {}).slice(0, 400)}</Text>
      </SectionMessage>
    );
  }
  if (loading) return <Text>Loading saved assumptions...</Text>;

  const broken = saved ? saved.assumptions.filter((a) => a.status === 'broken').length : 0;

  return (
    <Stack space="space.200">
      <Heading size="small">Premise</Heading>

      {error && (
        <SectionMessage appearance="error" title="Something went wrong">
          <Text>{error}</Text>
        </SectionMessage>
      )}

      {draft ? (
        /* Review step: confirm assumptions and set how each one is watched. */
        <Stack space="space.200">
          {draft.note && <Text>{draft.note}</Text>}
          {draft.decision && (
            <Text>
              <Strong>Decision:</Strong> {draft.decision}
            </Text>
          )}
          {draft.assumptions.length === 0 ? (
            <Text>No assumptions found on this page.</Text>
          ) : (
            draft.assumptions.map((a) => (
              <Stack key={a.id} space="space.075">
                <Checkbox
                  label={a.text}
                  isChecked={!!checked[a.id]}
                  onChange={() => setChecked({ ...checked, [a.id]: !checked[a.id] })}
                />
                {a.watchHint && <Text size="small">Watch: {a.watchHint}</Text>}
                {checked[a.id] && (
                  <TripwireEditor tripwire={a.tripwire} onChange={(t) => updateTripwire(a.id, t)} />
                )}
              </Stack>
            ))
          )}
          <Stack space="space.075">
            <Text>
              <Strong>Revisit tickets:</Strong> when a wire trips, open a Jira ticket in project
            </Text>
            <Textfield
              placeholder="Project key, e.g. KAN (leave empty for no tickets)"
              value={draft.ticketProjectKey || ''}
              onChange={(e) => setDraft({ ...draft, ticketProjectKey: e.target.value })}
            />
          </Stack>
          <Inline space="space.100">
            <LoadingButton appearance="primary" isLoading={working} onClick={save}>
              Save and check
            </LoadingButton>
            <Button appearance="subtle" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </Inline>
        </Stack>
      ) : saved ? (
        /* Saved view: live status of every assumption. */
        <Stack space="space.150">
          {broken > 0 && (
            <SectionMessage appearance="error" title={`${broken} assumption${broken === 1 ? '' : 's'} broken`}>
              <Text>This decision may need to be revisited.</Text>
            </SectionMessage>
          )}
          {saved.decision && (
            <Text>
              <Strong>Decision:</Strong> {saved.decision}
            </Text>
          )}
          {saved.assumptions.map((a) => {
            const s = STATUS[a.status] || STATUS.unwatched;
            return (
              <Stack key={a.id} space="space.050">
                <Inline space="space.100" alignBlock="center">
                  <Lozenge appearance={s.appearance}>{s.label}</Lozenge>
                  <Text>{a.text}</Text>
                </Inline>
                {a.evidence?.summary && <Text size="small">{a.evidence.summary}</Text>}
                {(a.evidence?.issues || []).map((i) => (
                  <Text key={i.key} size="small">
                    {i.key}: {i.summary}
                  </Text>
                ))}
                {a.ticket?.key && (
                  <Text size="small">
                    <Strong>Revisit ticket:</Strong> {a.ticket.key}
                  </Text>
                )}
                {a.ticketError && <Text size="small">Ticket not created: {a.ticketError}</Text>}
              </Stack>
            );
          })}
          {saved.lastCheckedAt && (
            <Text size="small">Last checked {new Date(saved.lastCheckedAt).toLocaleString()}</Text>
          )}
          <Inline space="space.100">
            <LoadingButton appearance="primary" isLoading={working} onClick={checkNow}>
              Check now
            </LoadingButton>
            <Button
              onClick={() => startDraft(saved.decision, saved.assumptions, null, saved.ticketProjectKey)}
            >
              Edit tripwires
            </Button>
            <LoadingButton appearance="subtle" isLoading={working} onClick={extract}>
              Extract again
            </LoadingButton>
          </Inline>
        </Stack>
      ) : (
        /* Empty state. */
        <Stack space="space.150">
          <Text>Find the decision on this page and the assumptions it rests on.</Text>
          <LoadingButton appearance="primary" isLoading={working} onClick={extract}>
            Extract assumptions
          </LoadingButton>
        </Stack>
      )}
    </Stack>
  );
};

// Safety net: show crash text instead of a blank panel.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('Premise panel crashed:', error);
  }
  render() {
    if (this.state.error) {
      return (
        <SectionMessage appearance="error" title="Premise hit an error">
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
