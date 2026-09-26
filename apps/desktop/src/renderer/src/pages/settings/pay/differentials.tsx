/** Shift differentials: nights, weekends, holidays, charge — flat or percentage, switchable. */

import type { Differential, DifferentialKind, Id } from '@shiftnurse/core';
import { COST_LINE_LABELS, DIFFERENTIAL_ORDER } from '@shiftnurse/core';
import { useState } from 'react';
import {
  useCreateDifferential,
  useDeleteDifferential,
  useDifferentials,
  useUpdateDifferential,
} from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { useConfirm } from '../../../components/confirm.js';
import { INPUT, LABEL, PRIMARY, SMALL, SMALL_DANGER, TD, TH } from '../../../components/ui.js';
import { formatDollars } from '../../../money.js';

const DIFFERENTIAL_HELP: Record<DifferentialKind, string> = {
  night: 'Shifts whose type is marked as night',
  weekend: 'Shifts inside the weekend window defined on the Rules tab',
  holiday: 'Shifts starting on a holiday from the Holidays tab',
  charge: 'Shifts where the nurse is the charge nurse',
  on_call: 'Standby hours — paid instead of base pay, not on top of it',
  call_back: 'Being called in while on standby (priced by the day-of console)',
  agency: 'Every worked shift of an agency nurse',
};

function describeAmount(d: Pick<Differential, 'mode' | 'amount'>): string {
  return d.mode === 'flat' ? `${formatDollars(d.amount, { cents: true })}/h` : `× ${d.amount}`;
}

export function DifferentialsSection({ unitId }: { unitId: Id }) {
  const confirm = useConfirm();
  const query = useDifferentials(unitId);
  const create = useCreateDifferential(unitId);
  const update = useUpdateDifferential(unitId);
  const remove = useDeleteDifferential(unitId);

  const [kind, setKind] = useState<DifferentialKind>('night');
  const [mode, setMode] = useState<Differential['mode']>('flat');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<Id | undefined>(undefined);
  const [editAmount, setEditAmount] = useState('');

  if (query.isPending) return <AsyncState status="loading" label="Loading differentials" />;
  if (query.isError) {
    return <AsyncState status="error" label="Could not load differentials" error={query.error} />;
  }

  const sorted = [...query.data].sort(
    (a, b) => DIFFERENTIAL_ORDER.indexOf(a.kind) - DIFFERENTIAL_ORDER.indexOf(b.kind),
  );

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-semibold text-text">Differentials</h2>
      <p className="mb-3 text-xs text-text-muted">
        Flat differentials add dollars per hour to the base rate; multipliers scale the rate after
        the flat ones are added, so a 1.5× holiday applies to base plus night plus charge.
      </p>

      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Number(amount);
          if (!(parsed >= 0)) {
            setError('An amount is required');
            return;
          }
          setError(undefined);
          create.mutate(
            { unitId, kind, mode, amount: parsed, active: true },
            { onSuccess: () => setAmount(''), onError: (e) => setError(e.message) },
          );
        }}
      >
        <label className={LABEL}>
          Kind
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as DifferentialKind)}
            className={INPUT}
            data-testid="differential-kind"
          >
            {DIFFERENTIAL_ORDER.map((k) => (
              <option key={k} value={k}>
                {COST_LINE_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Mode
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as Differential['mode'])}
            className={INPUT}
          >
            <option value="flat">Flat $ per hour</option>
            <option value="multiplier">Multiplier</option>
          </select>
        </label>
        <label className={LABEL}>
          {mode === 'flat' ? 'Dollars per hour' : 'Multiplier'}
          <input
            type="number"
            min={0}
            step={0.01}
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={`${INPUT} w-28`}
            data-testid="differential-amount"
          />
        </label>
        <button type="submit" className={PRIMARY} disabled={create.isPending}>
          Add differential
        </button>
        {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
      </form>

      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table
          className="w-full min-w-[520px] border-collapse text-sm"
          data-testid="differential-table"
        >
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className={TH}>
                Differential
              </th>
              <th scope="col" className={TH}>
                Amount
              </th>
              <th scope="col" className={TH}>
                Active
              </th>
              <th scope="col" className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                  No differentials — every shift prices at base rate.
                </td>
              </tr>
            ) : (
              sorted.map((d) => (
                <tr
                  key={d.id}
                  className={`border-b border-border last:border-0 ${d.active ? '' : 'opacity-60'}`}
                >
                  <td className={TD}>
                    <span className="font-medium">{COST_LINE_LABELS[d.kind]}</span>
                    <span className="block text-xs text-text-muted">
                      {DIFFERENTIAL_HELP[d.kind]}
                    </span>
                  </td>
                  <td className={TD}>
                    {editingId === d.id ? (
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={editAmount}
                        onChange={(event) => setEditAmount(event.target.value)}
                        className={`${INPUT} w-24`}
                        aria-label="Amount"
                      />
                    ) : (
                      describeAmount(d)
                    )}
                  </td>
                  <td className={TD}>
                    <input
                      type="checkbox"
                      checked={d.active}
                      aria-label={`${COST_LINE_LABELS[d.kind]} active`}
                      onChange={(event) =>
                        update.mutate({ id: d.id, patch: { active: event.target.checked } })
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {editingId === d.id ? (
                        <>
                          <button
                            type="button"
                            className={SMALL}
                            onClick={() => {
                              const parsed = Number(editAmount);
                              if (!(parsed >= 0)) return;
                              update.mutate(
                                { id: d.id, patch: { amount: parsed } },
                                { onSuccess: () => setEditingId(undefined) },
                              );
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className={SMALL}
                            onClick={() => setEditingId(undefined)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={SMALL}
                            onClick={() => {
                              setEditingId(d.id);
                              setEditAmount(String(d.amount));
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={SMALL_DANGER}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Delete the ${COST_LINE_LABELS[d.kind]}?`,
                                  confirmLabel: 'Delete',
                                })
                              ) {
                                remove.mutate(d.id);
                              }
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
