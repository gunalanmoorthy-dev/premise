// Premise byline panel (UI Kit). Opens from the "Premise" item on a Confluence page.
// Flow: Extract assumptions -> tick the ones that are right -> Save.

import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  Checkbox,
  Heading,
  Inline,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
  useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const App = () => {
  const context = useProductContext();
  const pageId = context?.extension?.content?.id;

  const [loading, setLoading] = useState(true); // first load of saved data
  const [working, setWorking] = useState(false); // extract or save in progress
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null); // what is stored for this page
  const [draft, setDraft] = useState(null); // fresh extraction waiting for review
  const [checked, setChecked] = useState({}); // assumption id -> ticked?

  // Load anything saved earlier for this page.
  useEffect(() => {
    if (!pageId) return;
    invoke('getSaved', { pageId })
      .then(setSaved)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [pageId]);

  const extract = async () => {
    setWorking(true);
    setError(null);
    try {
      const result = await invoke('extractAssumptions', { pageId });
      setDraft(result);
      // Tick every suggestion by default; the user unticks wrong ones.
      setChecked(Object.fromEntries(result.assumptions.map((a) => [a.id, true])));
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const save = async () => {
    setWorking(true);
    setError(null);
    try {
      const confirmed = draft.assumptions.filter((a) => checked[a.id]);
      const record = await invoke('saveAssumptions', {
        pageId,
        decision: draft.decision,
        assumptions: confirmed,
      });
      setSaved(record);
      setDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  if (!pageId || loading) {
    return <Spinner label="Loading Premise" />;
  }

  return (
    <Stack space="space.200">
      <Heading as="h3">Premise</Heading>

      {error && (
        <SectionMessage appearance="error" title="Something went wrong">
          <Text>{error}</Text>
        </SectionMessage>
      )}

      {/* Review step: show what Claude found and let the user confirm it. */}
      {draft ? (
        <Stack space="space.150">
          {draft.note && <Text>{draft.note}</Text>}
          {draft.decision && (
            <Text>
              <Strong>Decision:</Strong> {draft.decision}
            </Text>
          )}
          {draft.assumptions.length === 0 ? (
            <Text>No assumptions found on this page.</Text>
          ) : (
            <Stack space="space.100">
              <Text>Tick the assumptions that are right:</Text>
              {draft.assumptions.map((a) => (
                <Stack key={a.id} space="space.050">
                  <Checkbox
                    label={a.text}
                    isChecked={!!checked[a.id]}
                    onChange={() => setChecked({ ...checked, [a.id]: !checked[a.id] })}
                  />
                  {a.watchHint && <Text size="small">Watch: {a.watchHint}</Text>}
                </Stack>
              ))}
            </Stack>
          )}
          <Inline space="space.100">
            <LoadingButton appearance="primary" isLoading={working} onClick={save}>
              Save confirmed
            </LoadingButton>
            <Button appearance="subtle" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </Inline>
        </Stack>
      ) : saved ? (
        /* Saved view: the assumptions Premise is now holding for this page. */
        <Stack space="space.150">
          {saved.decision && (
            <Text>
              <Strong>Decision:</Strong> {saved.decision}
            </Text>
          )}
          {saved.assumptions.map((a) => (
            <Inline key={a.id} space="space.100" alignBlock="center">
              <Lozenge appearance="success">Holding</Lozenge>
              <Text>{a.text}</Text>
            </Inline>
          ))}
          <Text size="small">Saved {new Date(saved.savedAt).toLocaleString()}</Text>
          <LoadingButton isLoading={working} onClick={extract}>
            Extract again
          </LoadingButton>
        </Stack>
      ) : (
        /* Empty state: nothing saved yet. */
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

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
