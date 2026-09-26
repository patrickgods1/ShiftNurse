/** Pay rates: per nurse or per role, each effective from a date. */

import type { Id, IsoDate, Nurse, NurseRole, PayRate } from '@shiftnurse/core';
import { NURSE_ROLES } from '@shiftnurse/core';
import { useState } from 'react';
import {
  useCreatePayRate,
  useDeletePayRate,
  usePayRates,
  useUpdatePayRate,
} from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { INPUT, LABEL, PRIMARY, SMALL, SMALL_DANGER, TD, TH } from '../../../components/ui.js';
import { formatDate } from '../../../format.js';
import { formatDollars } from '../../../money.js';

function nurseName(nurse: Nurse): string {
  return `${nurse.lastName}, ${nurse.firstName}`;
}

function describeScope(rate: PayRate, nursesById: ReadonlyMap<Id, Nurse>): string {
  if (rate.nurseId !== null) {
    const nurse = nursesById.get(rate.nurseId);
    return nurse ? nurseName(nurse) : 'Unknown nurse';
  }
  return `${rate.role ?? '?'} default`;
}

export function PayRatesSection({ unitId, nurses }: { unitId: Id; nurses: Nurse[] }) {
  const ratesQuery = usePayRates(unitId);
  const createRate = useCreatePayRate(unitId);
  const updateRate = useUpdatePayRate(unitId);
  const deleteRate = useDeletePayRate(unitId);

  const [scope, setScope] = useState<string>('role:RN');
  const [hourly, setHourly] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<Id | undefined>(undefined);
  const [editHourly, setEditHourly] = useState('');

  if (ratesQuery.isPending) return <AsyncState status="loading" label="Loading pay rates" />;
  if (ratesQuery.isError) {
    return <AsyncState status="error" label="Could not load pay rates" error={ratesQuery.error} />;
  }

  const nursesById = new Map(nurses.map((n) => [n.id, n]));
  const activeNurses = [...nurses]
    .filter((n) => n.active)
    .sort((a, b) => nurseName(a).localeCompare(nurseName(b)));
  // Role defaults first, then nurses alphabetically; newest effective date first within each.
  const sorted = [...ratesQuery.data].sort((a, b) => {
    const aScope = a.nurseId === null ? `0:${a.role}` : `1:${describeScope(a, nursesById)}`;
    const bScope = b.nurseId === null ? `0:${b.role}` : `1:${describeScope(b, nursesById)}`;
    return aScope.localeCompare(bScope) || b.effectiveFrom.localeCompare(a.effectiveFrom);
  });

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-semibold text-text">Pay rates</h2>
      <p className="mb-3 text-xs text-text-muted">
        A nurse's own rate beats the role default. A raise is a new row from its effective date, so
        earlier shifts keep the old rate.
      </p>

      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const hourlyRate = Number(hourly);
          if (!(hourlyRate > 0) || effectiveFrom === '') {
            setError('An hourly rate above zero and an effective date are required');
            return;
          }
          setError(undefined);
          const [kind, value] = scope.split(':') as ['role' | 'nurse', string];
          createRate.mutate(
            {
              nurseId: kind === 'nurse' ? value : null,
              role: kind === 'role' ? (value as NurseRole) : null,
              hourlyRate,
              effectiveFrom: effectiveFrom as IsoDate,
            },
            {
              onSuccess: () => {
                setHourly('');
              },
              onError: (e) => setError(e.message),
            },
          );
        }}
      >
        <label className={LABEL}>
          Applies to
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className={INPUT}
            data-testid="pay-rate-scope"
          >
            <optgroup label="Role default">
              {NURSE_ROLES.map((role) => (
                <option key={role} value={`role:${role}`}>
                  {role} default
                </option>
              ))}
            </optgroup>
            <optgroup label="Individual nurse">
              {activeNurses.map((nurse) => (
                <option key={nurse.id} value={`nurse:${nurse.id}`}>
                  {nurseName(nurse)} ({nurse.role})
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className={LABEL}>
          Hourly rate ($)
          <input
            type="number"
            min={0}
            step={0.01}
            required
            value={hourly}
            onChange={(event) => setHourly(event.target.value)}
            className={`${INPUT} w-28`}
            data-testid="pay-rate-hourly"
          />
        </label>
        <label className={LABEL}>
          Effective from
          <input
            type="date"
            required
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className={INPUT}
          />
        </label>
        <button type="submit" className={PRIMARY} disabled={createRate.isPending}>
          Add rate
        </button>
        {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
      </form>

      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table
          className="w-full min-w-[520px] border-collapse text-sm"
          data-testid="pay-rate-table"
        >
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className={TH}>
                Applies to
              </th>
              <th scope="col" className={TH}>
                Hourly rate
              </th>
              <th scope="col" className={TH}>
                Effective from
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
                  No pay rates yet — every shift is unpriced until a role default exists.
                </td>
              </tr>
            ) : (
              sorted.map((rate) => (
                <tr key={rate.id} className="border-b border-border last:border-0">
                  <td className={TD}>{describeScope(rate, nursesById)}</td>
                  <td className={TD}>
                    {editingId === rate.id ? (
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={editHourly}
                        onChange={(event) => setEditHourly(event.target.value)}
                        className={`${INPUT} w-28`}
                        aria-label="Hourly rate"
                      />
                    ) : (
                      formatDollars(rate.hourlyRate, { cents: true })
                    )}
                  </td>
                  <td className={TD}>{formatDate(rate.effectiveFrom)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {editingId === rate.id ? (
                        <>
                          <button
                            type="button"
                            className={SMALL}
                            onClick={() => {
                              const hourlyRate = Number(editHourly);
                              if (!(hourlyRate > 0)) return;
                              updateRate.mutate(
                                { id: rate.id, patch: { hourlyRate } },
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
                              setEditingId(rate.id);
                              setEditHourly(String(rate.hourlyRate));
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={SMALL_DANGER}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete the ${describeScope(rate, nursesById)} rate of ${formatDollars(rate.hourlyRate, { cents: true })}?`,
                                )
                              ) {
                                deleteRate.mutate(rate.id);
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
