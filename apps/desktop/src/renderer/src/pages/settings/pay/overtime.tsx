/**
 * Overtime rules: the daily, weekly, pay-period or seventh-day thresholds and multipliers
 * costing prices against.
 */

import type { Id, OvertimeRule } from '@shiftnurse/core';
import { useState } from 'react';
import {
  useCreateOvertimeRule,
  useDeleteOvertimeRule,
  useOvertimeRules,
  useUpdateOvertimeRule,
} from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { useConfirm } from '../../../components/confirm.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { INPUT, LABEL, PRIMARY, SMALL_DANGER, TD, TH } from '../../../components/ui.js';

const BASIS_SPAN: Record<OvertimeRule['basis'], string> = {
  daily: 'a workday',
  weekly: 'a work week',
  pay_period: 'a pay period',
  seventh_day: 'the seventh day in a row of a work week',
  beyond_scheduled_tour: 'past the end of the scheduled tour',
  consecutive: 'hours worked without a break',
  beyond_scheduled_days: 'a workday beyond the scheduled days per week',
};

// What the threshold means for the two bases whose zero or 8 is not obvious from "hours".
const THRESHOLD_HINT: Partial<Record<OvertimeRule['basis'], string>> = {
  beyond_scheduled_tour: 'Grace before a holdover becomes overtime; 0 for none.',
  consecutive: 'Hours worked without a break before overtime starts (38 U.S.C. §7453(e): 8).',
  beyond_scheduled_days:
    'Hours on an extra workday before the premium (Wage Order 5 § 3(B)(8): 8). Set Scheduled days per week on the roster for each nurse.',
};

function describeRule(rule: OvertimeRule): string {
  const base =
    rule.thresholdHours === 0
      ? `Every hour on ${BASIS_SPAN[rule.basis]}`
      : `Over ${rule.thresholdHours}h in ${BASIS_SPAN[rule.basis]}`;
  const notes = [
    rule.pyramiding === 'none' ? ', daily overtime not counted' : '',
    rule.minimumMinutes ? `, under ${rule.minimumMinutes} min unpaid` : '',
  ];
  return base + notes.join('');
}

export function OvertimeSection({ unitId }: { unitId: Id }) {
  const confirm = useConfirm();
  const query = useOvertimeRules(unitId);
  const create = useCreateOvertimeRule(unitId);
  const update = useUpdateOvertimeRule(unitId);
  const remove = useDeleteOvertimeRule(unitId);

  const [basis, setBasis] = useState<OvertimeRule['basis']>('weekly');
  const [threshold, setThreshold] = useState('40');
  const [multiplier, setMultiplier] = useState('1.5');
  const [minimumMinutes, setMinimumMinutes] = useState('');
  const [noPyramiding, setNoPyramiding] = useState(false);
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
        included. An hour is overtime once, at the highest multiplier any rule gives it: with 1.5×
        past 8 hours a day and 2× past 12, a 13-hour shift is 4 hours at 1.5× and 1 at 2×. A workday
        is every shift that starts on that date. The work week starts on the day set in the Rules
        tab; a pay-period rule (such as 80 hours in 14 days) counts over the unit's pay period
        instead. A seventh-day rule applies on the seventh day in a row worked in one work week
        (California: threshold 0 at 1.5×, and 8 at 2×). A minimum of minutes pays overtime shorter
        than that on a shift as straight time. A weekly or pay-period rule can leave out hours
        already paid as daily overtime, so they do not count toward its threshold.
      </p>

      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const thresholdHours = Number(threshold);
          const parsedMultiplier = Number(multiplier);
          if (!(thresholdHours >= 0) || !(parsedMultiplier >= 1)) {
            setError('A threshold of zero or more and a multiplier of at least 1 are required');
            return;
          }
          const minutes = Number(minimumMinutes);
          if (minimumMinutes.trim() !== '' && !(Number.isInteger(minutes) && minutes >= 0)) {
            setError('Minimum minutes must be a whole number, zero or more');
            return;
          }
          setError(undefined);
          create.mutate(
            {
              unitId,
              basis,
              thresholdHours,
              multiplier: parsedMultiplier,
              active: true,
              ...(minimumMinutes.trim() !== '' ? { minimumMinutes: minutes } : {}),
              ...(noPyramiding && (basis === 'weekly' || basis === 'pay_period')
                ? { pyramiding: 'none' as const }
                : {}),
            },
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
            <option value="pay_period">Per pay period</option>
            <option value="daily">Per workday</option>
            <option value="seventh_day">Seventh day in a row</option>
            <option value="beyond_scheduled_tour">Past the end of the scheduled tour</option>
            <option value="consecutive">Consecutive hours worked</option>
            <option value="beyond_scheduled_days">
              Workday beyond the scheduled days per week
            </option>
          </select>
        </label>
        <Field id="overtime-threshold" label="Threshold (hours)" hint={THRESHOLD_HINT[basis]}>
          <input
            id="overtime-threshold"
            aria-describedby={describedBy('overtime-threshold', {
              hint: THRESHOLD_HINT[basis] !== undefined,
            })}
            type="number"
            min={0}
            step={0.5}
            required
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            className={`${INPUT} w-24`}
          />
        </Field>
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
        <Field
          id="overtime-minimum-minutes"
          label="Minimum minutes"
          hint="Overtime shorter than this is paid as straight time (VA: 15)."
        >
          <input
            id="overtime-minimum-minutes"
            aria-describedby={describedBy('overtime-minimum-minutes', { hint: true })}
            type="number"
            min={0}
            max={240}
            step={1}
            value={minimumMinutes}
            onChange={(event) => setMinimumMinutes(event.target.value)}
            className={`${INPUT} w-24`}
          />
        </Field>
        {basis === 'weekly' || basis === 'pay_period' ? (
          <label className="flex items-center gap-1 text-xs text-text">
            <input
              type="checkbox"
              checked={noPyramiding}
              onChange={(event) => setNoPyramiding(event.target.checked)}
            />
            Don't count daily overtime toward this threshold
          </label>
        ) : null}
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
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete "${describeRule(rule)}"?`,
                            confirmLabel: 'Delete',
                          })
                        ) {
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
