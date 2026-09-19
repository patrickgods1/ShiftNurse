/**
 * Auto-resolve policy. Off by default, and the copy says plainly what turning it on means:
 * the app will change the draft on its own, within the thresholds, and every such change is
 * written to the audit log as `auto_resolve` quoting the resolution's own justification.
 */

import type { AutoResolvePolicy } from '@shiftnurse/core';
import { useState } from 'react';
import { useConflictPolicy, useSaveConflictPolicy } from '../../api-requests.js';
import { AsyncState } from '../../components/async-state.js';
import { useUnitId } from '../../unit-context.js';

const INPUT = 'rounded-md border border-border bg-bg px-2 py-1 text-sm text-text';
const LABEL = 'flex flex-col gap-1 text-xs text-text-muted';
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';

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

  return (
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
        className="mt-4 flex max-w-md flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          save.mutate(
            { enabled, maxCostDelta: costNumber, maxFairnessDrop: dropNumber },
            { onSuccess: () => setMessage('Saved.') },
          );
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
        <label className={LABEL}>
          Maximum added cost per resolution (dollars)
          <input
            type="number"
            min={0}
            step={1}
            className={INPUT}
            value={maxCost}
            onChange={(e) => setMaxCost(e.target.value)}
          />
        </label>
        <label className={LABEL}>
          Maximum drop in unit fairness score (points, 0–100 scale)
          <input
            type="number"
            min={0}
            step={0.5}
            className={INPUT}
            value={maxDrop}
            onChange={(e) => setMaxDrop(e.target.value)}
          />
        </label>
        {save.error instanceof Error ? (
          <p role="alert" className="text-sm text-danger">
            {save.error.message}
          </p>
        ) : message !== undefined && !dirty ? (
          <p role="status" className="text-sm text-success">
            {message}
          </p>
        ) : null}
        <div>
          <button type="submit" className={PRIMARY} disabled={!valid || !dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </form>
    </section>
  );
}
