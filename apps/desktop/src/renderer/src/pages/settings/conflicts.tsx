/**
 * Auto-resolve policy. Off by default, and the copy says plainly what turning it on means:
 * the app will change the draft on its own, within the thresholds, and every such change is
 * written to the audit log as `auto_resolve` quoting the resolution's own justification.
 */

import type { AutoResolvePolicy } from '@shiftnurse/core';
import { useState } from 'react';
import { useConflictPolicy, useSaveConflictPolicy } from '../../api-requests.js';
import { AsyncState } from '../../components/async-state.js';
import { EditorShell } from '../../components/editor-shell.js';
import { describedBy, Field } from '../../components/field-help.js';
import { INPUT } from '../../components/ui.js';
import { useUnitId } from '../../unit-context.js';

export default function ConflictsPanel() {
  const unitId = useUnitId();
  const policyQuery = useConflictPolicy(unitId);
  if (policyQuery.isPending) return <AsyncState status="loading" label="Loading policy" />;
  if (policyQuery.isError) {
    return <AsyncState status="error" label="Could not load policy" error={policyQuery.error} />;
  }
  return <PolicyForm key={JSON.stringify(policyQuery.data)} saved={policyQuery.data} />;
}

function PolicyForm({ saved }: { saved: AutoResolvePolicy }) {
  const unitId = useUnitId();
  const save = useSaveConflictPolicy(unitId);
  const [enabled, setEnabled] = useState(saved.enabled);
  const [maxCost, setMaxCost] = useState(String(saved.maxCostDelta));
  const [maxDrop, setMaxDrop] = useState(String(saved.maxFairnessDrop));
  const [message, setMessage] = useState<string | undefined>(undefined);

  const costNumber = Number(maxCost);
  const dropNumber = Number(maxDrop);
  const valid =
    Number.isFinite(costNumber) &&
    costNumber >= 0 &&
    Number.isFinite(dropNumber) &&
    dropNumber >= 0;
  const dirty =
    enabled !== saved.enabled ||
    costNumber !== saved.maxCostDelta ||
    dropNumber !== saved.maxFairnessDrop;

  function submit() {
    if (!valid) return;
    save.mutate(
      { enabled, maxCostDelta: costNumber, maxFairnessDrop: dropNumber },
      { onSuccess: () => setMessage('Saved.') },
    );
  }
  function discard() {
    setEnabled(saved.enabled);
    setMaxCost(String(saved.maxCostDelta));
    setMaxDrop(String(saved.maxFairnessDrop));
    setMessage(undefined);
    save.reset();
  }

  return (
    <EditorShell
      label="Conflicts"
      dirty={dirty}
      saving={save.isPending}
      error={save.error}
      canSave={valid}
      formId="conflict-policy-form"
      onSave={submit}
      onDiscard={discard}
      saveLabel="Save policy"
    >
      <section
        className="rounded-md border border-border bg-surface p-4"
        data-testid="conflict-policy"
      >
        <h2 className="text-sm font-semibold text-text">Auto-resolve</h2>
        <p className="mt-1 max-w-prose text-sm text-text-muted">
          When on, "Auto-resolve now" on the Requests page applies, without asking, any resolution
          that fully closes its conflict, introduces no soft violation, costs no more than the limit
          below and drops the unit fairness score by no more than the limit below.{' '}
          <strong className="text-text">
            Everything auto-applied is written to the audit log as an automatic resolution, quoting
            its own justification.
          </strong>{' '}
          It never runs on its own; the manager still presses the button.
        </p>
        <form
          id="conflict-policy-form"
          className="mt-4 flex max-w-md flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid="policy-enabled"
            />
            Allow automatic resolution
          </label>
          <Field
            id="policy-max-cost"
            label="Most added cost per resolution (dollars)"
            hint="A fix that adds more than this to the schedule's cost is left for you to decide."
            tip={
              'Overtime, differentials and agency staff all add cost. 0 allows only fixes that cost ' +
              'nothing extra; a few hundred dollars lets it apply a fix such as one overtime shift.'
            }
            disabled={!enabled}
          >
            <input
              id="policy-max-cost"
              type="number"
              min={0}
              step={1}
              className={INPUT}
              value={maxCost}
              disabled={!enabled}
              aria-describedby={describedBy('policy-max-cost', { hint: true })}
              onChange={(e) => setMaxCost(e.target.value)}
            />
          </Field>
          <Field
            id="policy-max-drop"
            label="Most drop in unit fairness score (points)"
            hint="The fairness score runs 0–100. A fix that lowers it by more is left for you."
            tip={
              'A small allowance, 1 or 2 points, lets it fix conflicts that shift a little burden ' +
              'onto someone. 0 allows only fixes that leave the team at least as fair as before.'
            }
            disabled={!enabled}
          >
            <input
              id="policy-max-drop"
              type="number"
              min={0}
              step={0.5}
              className={INPUT}
              value={maxDrop}
              disabled={!enabled}
              aria-describedby={describedBy('policy-max-drop', { hint: true })}
              onChange={(e) => setMaxDrop(e.target.value)}
            />
          </Field>
          {save.error === null && message !== undefined && !dirty ? (
            <p role="status" className="text-sm text-success">
              {message}
            </p>
          ) : null}
        </form>
      </section>
    </EditorShell>
  );
}
