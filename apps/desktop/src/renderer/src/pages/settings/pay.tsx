/**
 * Pay configuration: base rates (a default per role plus per-nurse overrides), the
 * differentials that stack on top of them, and the overtime rules. Everything the cost engine
 * prices from lives on this one tab, because a manager reconciling a payroll surprise wants to
 * check "what do we pay for a Saturday night charge shift" in one place.
 *
 * Rates are dated rather than edited in place: a raise is a new row effective from a date, so
 * the shifts before it keep pricing at the old rate. Editing an existing row exists for typos.
 */

import type {
  Differential,
  DifferentialKind,
  Id,
  IsoDate,
  Nurse,
  NurseRole,
  OvertimeRule,
  PayRate,
} from '@shiftnurse/core';
import { COST_LINE_LABELS, DIFFERENTIAL_ORDER, NURSE_ROLES } from '@shiftnurse/core';
import { useState } from 'react';
import { useNurses } from '../../api.js';
import {
  useCreateDifferential,
  useCreateOvertimeRule,
  useCreatePayRate,
  useDeleteDifferential,
  useDeleteOvertimeRule,
  useDeletePayRate,
  useDifferentials,
  useOvertimeRules,
  usePayRates,
  useUpdateDifferential,
  useUpdateOvertimeRule,
  useUpdatePayRate,
} from '../../api-cost.js';
import { AsyncState } from '../../components/async-state.js';
import { formatDate } from '../../format.js';
import { formatDollars } from '../../money.js';
import { useUnitId } from '../../unit-context.js';

const INPUT = 'rounded-md border border-border bg-bg px-2 py-1 text-sm text-text';
const LABEL = 'flex flex-col gap-1 text-xs text-text-muted';
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';
const SMALL = 'rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg';
const SMALL_DANGER = 'rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-bg';
const TH = 'px-3 py-2 font-medium';
const TD = 'px-3 py-2 text-text';

function nurseName(nurse: Nurse): string {
  return `${nurse.lastName}, ${nurse.firstName}`;
}

// ---------------------------------------------------------------------------
// Pay rates
// ---------------------------------------------------------------------------

function describeScope(rate: PayRate, nursesById: ReadonlyMap<Id, Nurse>): string {
  if (rate.nurseId !== null) {
    const nurse = nursesById.get(rate.nurseId);
    return nurse ? nurseName(nurse) : 'Unknown nurse';
  }
  return `${rate.role ?? '?'} default`;
}

function PayRatesSection({ unitId, nurses }: { unitId: Id; nurses: Nurse[] }) {
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

// ---------------------------------------------------------------------------
// Differentials
// ---------------------------------------------------------------------------

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

function DifferentialsSection({ unitId }: { unitId: Id }) {
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
                            onClick={() => {
                              if (window.confirm(`Delete the ${COST_LINE_LABELS[d.kind]}?`)) {
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

// ---------------------------------------------------------------------------
// Overtime rules
// ---------------------------------------------------------------------------

function describeRule(rule: OvertimeRule): string {
  return rule.basis === 'daily'
    ? `Over ${rule.thresholdHours}h in one shift`
    : `Over ${rule.thresholdHours}h in a work week`;
}

function OvertimeSection({ unitId }: { unitId: Id }) {
  const query = useOvertimeRules(unitId);
  const create = useCreateOvertimeRule(unitId);
  const update = useUpdateOvertimeRule(unitId);
  const remove = useDeleteOvertimeRule(unitId);

  const [basis, setBasis] = useState<OvertimeRule['basis']>('weekly');
  const [threshold, setThreshold] = useState('40');
  const [multiplier, setMultiplier] = useState('1.5');
  const [error, setError] = useState<string | undefined>(undefined);

  if (query.isPending) return <AsyncState status="loading" label="Loading overtime rules" />;
  if (query.isError) {
    return <AsyncState status="error" label="Could not load overtime rules" error={query.error} />;
  }

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-text">Overtime</h2>
      <p className="mb-3 text-xs text-text-muted">
        Hours past the threshold earn the multiplier on the shift's full rate, differentials
        included. An hour is overtime once: where a daily and a weekly rule both apply, the one
        paying more for that shift wins. The work week starts on the day set in the Rules tab.
      </p>

      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const thresholdHours = Number(threshold);
          const parsedMultiplier = Number(multiplier);
          if (!(thresholdHours > 0) || !(parsedMultiplier >= 1)) {
            setError('A threshold above zero and a multiplier of at least 1 are required');
            return;
          }
          setError(undefined);
          create.mutate(
            { unitId, basis, thresholdHours, multiplier: parsedMultiplier, active: true },
            { onError: (e) => setError(e.message) },
          );
        }}
      >
        <label className={LABEL}>
          Basis
          <select
            value={basis}
            onChange={(event) => setBasis(event.target.value as OvertimeRule['basis'])}
            className={INPUT}
          >
            <option value="weekly">Per work week</option>
            <option value="daily">Per shift</option>
          </select>
        </label>
        <label className={LABEL}>
          Threshold (hours)
          <input
            type="number"
            min={0}
            step={0.5}
            required
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            className={`${INPUT} w-24`}
          />
        </label>
        <label className={LABEL}>
          Multiplier
          <input
            type="number"
            min={1}
            step={0.05}
            required
            value={multiplier}
            onChange={(event) => setMultiplier(event.target.value)}
            className={`${INPUT} w-24`}
          />
        </label>
        <button type="submit" className={PRIMARY} disabled={create.isPending}>
          Add rule
        </button>
        {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
      </form>

      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table
          className="w-full min-w-[520px] border-collapse text-sm"
          data-testid="overtime-table"
        >
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className={TH}>
                Rule
              </th>
              <th scope="col" className={TH}>
                Multiplier
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
            {query.data.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                  No overtime rules — no hours are priced as overtime.
                </td>
              </tr>
            ) : (
              query.data.map((rule) => (
                <tr
                  key={rule.id}
                  className={`border-b border-border last:border-0 ${rule.active ? '' : 'opacity-60'}`}
                >
                  <td className={TD}>{describeRule(rule)}</td>
                  <td className={TD}>× {rule.multiplier}</td>
                  <td className={TD}>
                    <input
                      type="checkbox"
                      checked={rule.active}
                      aria-label={`${describeRule(rule)} active`}
                      onChange={(event) =>
                        update.mutate({ id: rule.id, patch: { active: event.target.checked } })
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className={SMALL_DANGER}
                      onClick={() => {
                        if (window.confirm(`Delete "${describeRule(rule)}"?`)) {
                          remove.mutate(rule.id);
                        }
                      }}
                    >
                      Delete
                    </button>
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

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function PayPanel() {
  const unitId = useUnitId();
  const nursesQuery = useNurses(unitId);

  if (nursesQuery.isPending) return <AsyncState status="loading" label="Loading roster" />;
  if (nursesQuery.isError) {
    return <AsyncState status="error" label="Could not load roster" error={nursesQuery.error} />;
  }

  return (
    <div data-testid="pay-panel">
      <PayRatesSection unitId={unitId} nurses={nursesQuery.data} />
      <DifferentialsSection unitId={unitId} />
      <OvertimeSection unitId={unitId} />
    </div>
  );
}
