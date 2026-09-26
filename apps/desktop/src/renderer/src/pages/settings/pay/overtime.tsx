/** Overtime rules: the weekly or daily thresholds and multipliers costing prices against. */

import type { Id, OvertimeRule } from '@shiftnurse/core';
import { useState } from 'react';
import {
  useCreateOvertimeRule,
  useDeleteOvertimeRule,
  useOvertimeRules,
  useUpdateOvertimeRule,
} from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { INPUT, LABEL, PRIMARY, SMALL_DANGER, TD, TH } from '../../../components/ui.js';

function describeRule(rule: OvertimeRule): string {
  return rule.basis === 'daily'
    ? `Over ${rule.thresholdHours}h in one shift`
    : `Over ${rule.thresholdHours}h in a work week`;
}

export function OvertimeSection({ unitId }: { unitId: Id }) {
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
