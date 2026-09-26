/**
 * The unit's default solver. Generate uses it unless the manager picks another for one run; a
 * backend this install cannot run is shown, disabled, with the reason, so a unit set to hybrid on
 * a machine without the OR-Tools runner is never a mystery — Generate falls back and says so.
 */

import { FALLBACK_ORDER, type SolverSettings } from '@shiftnurse/core';
import { useState } from 'react';
import type { SolverAvailability } from '../../../../shared/api.js';
import {
  useSaveSolverSettings,
  useSolverAvailability,
  useSolverSettings,
} from '../../api-solver.js';
import { AsyncState } from '../../components/async-state.js';
import { PRIMARY } from '../../components/ui.js';
import { SOLVER_LABELS, SOLVER_ORDER } from '../../solver-labels.js';
import { useUnitId } from '../../unit-context.js';

export default function SolverPanel() {
  const unitId = useUnitId();
  const settingsQuery = useSolverSettings(unitId);
  const availabilityQuery = useSolverAvailability();
  if (settingsQuery.isPending || availabilityQuery.isPending) {
    return <AsyncState status="loading" label="Loading solver settings" />;
  }
  if (settingsQuery.isError) {
    return (
      <AsyncState
        status="error"
        label="Could not load solver settings"
        error={settingsQuery.error}
      />
    );
  }
  if (availabilityQuery.isError) {
    return (
      <AsyncState
        status="error"
        label="Could not check which solvers are installed"
        error={availabilityQuery.error}
      />
    );
  }
  return (
    <SolverForm
      key={JSON.stringify(settingsQuery.data)}
      saved={settingsQuery.data}
      availability={availabilityQuery.data}
    />
  );
}

function SolverForm({
  saved,
  availability,
}: {
  saved: SolverSettings;
  availability: SolverAvailability[];
}) {
  const unitId = useUnitId();
  const save = useSaveSolverSettings(unitId);
  const [solverId, setSolverId] = useState(saved.solverId);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const dirty = solverId !== saved.solverId;
  const byId = new Map(availability.map((a) => [a.id, a]));
  const chosenUnavailable = byId.get(solverId)?.available === false;
  const fallback = FALLBACK_ORDER.find((id) => byId.get(id)?.available);

  return (
    <section
      className="rounded-md border border-border bg-surface p-4"
      data-testid="solver-settings"
    >
      <h2 className="text-sm font-semibold text-text">Solver</h2>
      <p className="mt-1 max-w-prose text-sm text-text-muted">
        The engine Generate uses to build a schedule. Every engine obeys the same rules and is
        checked by the same validation the grid shows; they differ in how hard they search and
        whether they can prove the result is close to the best possible. You can still pick a
        different one for a single run in the Generate dialog.
      </p>
      <form
        className="mt-4 flex max-w-xl flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ ...saved, solverId }, { onSuccess: () => setMessage('Saved.') });
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Default solver</legend>
          {SOLVER_ORDER.map((id) => {
            const entry = byId.get(id);
            const unavailable = entry?.available === false;
            return (
              <label
                key={id}
                className="flex items-start gap-2 rounded-md border border-border p-3 text-sm"
              >
                <input
                  type="radio"
                  name="solver"
                  value={id}
                  className="mt-1"
                  checked={solverId === id}
                  onChange={() => setSolverId(id)}
                  data-testid={`solver-option-${id}`}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-text">{SOLVER_LABELS[id].name}</span>
                  <span className="text-text-muted">{SOLVER_LABELS[id].summary}</span>
                  {unavailable ? (
                    <span className="text-warn">Not available here: {entry?.reason}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
        {chosenUnavailable && fallback ? (
          <p role="note" className="text-sm text-text-muted">
            Until it is installed, Generate will fall back to{' '}
            <strong className="text-text">{SOLVER_LABELS[fallback].name}</strong> and say so in its
            summary.
          </p>
        ) : null}
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
          <button type="submit" className={PRIMARY} disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save solver'}
          </button>
        </div>
      </form>
    </section>
  );
}
