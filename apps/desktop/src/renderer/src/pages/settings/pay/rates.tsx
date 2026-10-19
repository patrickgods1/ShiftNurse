/** Pay rates: per nurse or per role, each effective from a date. */

import type { Id, IsoDate, Nurse, NurseRole, PayRate, ScheduleKind } from '@shiftnurse/core';
import { NURSE_ROLES, today } from '@shiftnurse/core';
import { useState } from 'react';
import {
  useCreatePayRate,
  useDeletePayRate,
  usePayRates,
  useUpdatePayRate,
} from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { useConfirm } from '../../../components/confirm.js';
import { DateField } from '../../../components/date-field.js';
import { INPUT, LABEL, PRIMARY, SMALL, SMALL_DANGER, TD, TH } from '../../../components/ui.js';
import { useUnsavedChanges } from '../../../components/unsaved-changes.js';
import { formatDate } from '../../../format.js';
import { formatDollars } from '../../../money.js';

function nurseName(nurse: Nurse): string {
  return `${nurse.lastName}, ${nurse.firstName}`;
}

// Why a worked-hours rate on these plans is not the payroll's salary ÷ 2,080.
const DIVISOR_NOTE: Partial<Record<ScheduleKind, string>> = {
  va_72_80: '72/80: hourly rate is annual salary ÷ 1,872 (38 U.S.C. § 7456A(b)(2))',
  va_baylor: 'Baylor plan: annual salary ÷ 1,248 (38 U.S.C. § 7456(b))',
};

function describeScope(rate: PayRate, nursesById: ReadonlyMap<Id, Nurse>): string {
  if (rate.nurseId !== null) {
    const nurse = nursesById.get(rate.nurseId);
    return nurse ? nurseName(nurse) : 'Unknown nurse';
  }
  return `${rate.role ?? '?'} default`;
}

/** Two nurses can share a name; only the id says whose rate this is. */
function scopeKey(rate: PayRate): string {
  return rate.nurseId !== null ? `nurse:${rate.nurseId}` : `role:${rate.role}`;
}

export function PayRatesSection({ unitId, nurses }: { unitId: Id; nurses: Nurse[] }) {
  const confirm = useConfirm();
  const ratesQuery = usePayRates(unitId);
  const createRate = useCreatePayRate(unitId);
  const updateRate = useUpdatePayRate(unitId);
  const deleteRate = useDeletePayRate(unitId);

  const [scope, setScope] = useState<string>('role:RN');
  const [hourly, setHourly] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState<IsoDate | ''>('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<Id | undefined>(undefined);
  const [editHourly, setEditHourly] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const editing = ratesQuery.data?.find((r) => r.id === editingId);
  useUnsavedChanges(
    'Pay rates',
    editing !== undefined && editHourly !== String(editing.hourlyRate),
  );
  useUnsavedChanges('New pay rate', hourly !== '' || effectiveFrom !== '');

  if (ratesQuery.isPending) return <AsyncState status="loading" label="Loading pay rates" />;
  if (ratesQuery.isError) {
    return <AsyncState status="error" label="Could not load pay rates" error={ratesQuery.error} />;
  }

  const nursesById = new Map(nurses.map((n) => [n.id, n]));
  const activeNurses = [...nurses]
    .filter((n) => n.active)
    .sort((a, b) => nurseName(a).localeCompare(nurseName(b)));
  // Labels shared by two different nurses get the employee id, so the manager can tell them apart.
  const labelOf = new Map<string, string>();
  const keysByLabel = new Map<string, Set<string>>();
  for (const rate of ratesQuery.data) {
    const key = scopeKey(rate);
    const label = describeScope(rate, nursesById);
    labelOf.set(key, label);
    keysByLabel.set(label, (keysByLabel.get(label) ?? new Set()).add(key));
  }
  for (const [key, label] of labelOf) {
    if ((keysByLabel.get(label)?.size ?? 0) < 2) continue;
    const nurse = nursesById.get(key.slice('nurse:'.length));
    if (nurse) labelOf.set(key, `${label} (${nurse.employeeId})`);
  }
  // Role defaults first (by role), then nurses by label, then key so equal names keep a fixed
  // order; newest effective date first within each.
  const sorted = [...ratesQuery.data].sort((a, b) => {
    const aKey = scopeKey(a);
    const bKey = scopeKey(b);
    const aRole = a.nurseId === null;
    const bRole = b.nurseId === null;
    if (aRole !== bRole) return aRole ? -1 : 1;
    return (
      (aRole
        ? String(a.role).localeCompare(String(b.role))
        : (labelOf.get(aKey) ?? '').localeCompare(labelOf.get(bKey) ?? '') ||
          aKey.localeCompare(bKey)) || b.effectiveFrom.localeCompare(a.effectiveFrom)
    );
  });
  // One line per role default or nurse: the rate in force today and any raise still to come.
  // Older rates still price older shifts, so they stay — folded behind "+N earlier".
  const now = today();
  const needle = search.trim().toLowerCase();
  const visible: {
    rate: (typeof sorted)[number];
    earlier: number;
    history: boolean;
    key: string;
    scope: string;
  }[] = [];
  const scopes = new Map<string, typeof sorted>();
  for (const rate of sorted) {
    const key = scopeKey(rate);
    if (needle && !(labelOf.get(key) ?? '').toLowerCase().includes(needle)) continue;
    scopes.set(key, [...(scopes.get(key) ?? []), rate]);
  }
  for (const [key, rates] of scopes) {
    const scope = labelOf.get(key) ?? '';
    const currentIdx = rates.findIndex((r) => r.effectiveFrom <= now);
    const cut = currentIdx === -1 ? rates.length : currentIdx + 1;
    const older = rates.slice(cut);
    for (const [i, rate] of rates.slice(0, cut).entries()) {
      visible.push({ rate, earlier: i === cut - 1 ? older.length : 0, history: false, key, scope });
    }
    if (expanded.has(key)) {
      for (const rate of older) visible.push({ rate, earlier: 0, history: true, key, scope });
    }
  }

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
              effectiveFrom,
            },
            {
              onSuccess: () => {
                setHourly('');
                setEffectiveFrom('');
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
        <DateField
          label="Effective from"
          required
          value={effectiveFrom}
          onChange={setEffectiveFrom}
        />
        <button type="submit" className={PRIMARY} disabled={createRate.isPending}>
          Add rate
        </button>
        {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
      </form>

      <input
        type="search"
        aria-label="Find a rate by nurse or role"
        placeholder="Find a nurse or role…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className={`${INPUT} mb-2 w-72`}
      />
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
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                  No rates match “{search.trim()}”.
                </td>
              </tr>
            ) : (
              visible.map(({ rate, earlier, history, key, scope }) => (
                <tr
                  key={rate.id}
                  className={`border-b border-border last:border-0 ${history ? 'bg-bg text-text-muted' : ''}`}
                >
                  <td className={TD}>
                    {history ? <span className="pl-4 text-xs">earlier rate</span> : scope}
                    {!history && rate.nurseId !== null ? (
                      <DivisorNote kind={nursesById.get(rate.nurseId)?.scheduleKind} />
                    ) : null}
                    {rate.effectiveFrom > now ? (
                      <span className="ml-2 rounded-full bg-accent/15 px-1.5 py-0.5 text-xs text-accent">
                        upcoming
                      </span>
                    ) : null}
                    {earlier > 0 ? (
                      <button
                        type="button"
                        className="ml-2 text-xs text-accent underline underline-offset-2"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      >
                        {expanded.has(key) ? 'hide earlier' : `+${earlier} earlier`}
                      </button>
                    ) : null}
                  </td>
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
                    <div className="flex flex-wrap justify-end gap-2">
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
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Delete the ${scope} rate of ${formatDollars(rate.hourlyRate, { cents: true })}?`,
                                  confirmLabel: 'Delete',
                                })
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

function DivisorNote({ kind }: { kind: ScheduleKind | undefined }) {
  const note = kind === undefined ? undefined : DIVISOR_NOTE[kind];
  return note === undefined ? null : (
    <span className="mt-0.5 block text-xs text-text-muted">{note}</span>
  );
}
