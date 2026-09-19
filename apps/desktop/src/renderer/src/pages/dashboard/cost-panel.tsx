/**
 * Budget vs. actual for the period the manager is working on, and who is carrying the
 * overtime. Total overtime is the finance question; the ranked table is the burnout question —
 * "we're 4% over" and "one nurse worked 40 of our 48 overtime hours" call for different
 * conversations, so both sit side by side.
 *
 * The budget is editable in place because it is a single number per period and sending a
 * manager to a settings tab to change it would guarantee it is never set.
 */

import type { Nurse, SchedulePeriod } from '@shiftnurse/core';
import { useState } from 'react';
import { useCostReport, useSetBudget } from '../../api-cost.js';
import { AsyncState } from '../../components/async-state.js';
import { formatDate } from '../../format.js';
import { formatDollars, formatHours, formatSignedDollars } from '../../money.js';

interface CostPanelProps {
  period: SchedulePeriod;
  nurses: readonly Nurse[];
}

function BudgetEditor({
  period,
  current,
}: {
  period: SchedulePeriod;
  current: number | undefined;
}) {
  const setBudget = useSetBudget(period.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  if (!editing) {
    return (
      <button
        type="button"
        data-testid="edit-budget"
        onClick={() => {
          setValue(current === undefined ? '' : String(current));
          setEditing(true);
        }}
        className="text-xs text-accent underline underline-offset-2 hover:no-underline"
      >
        {current === undefined ? 'Set budget' : 'Edit budget'}
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = Number(value);
        if (!(parsed >= 0)) return;
        setBudget.mutate(parsed, { onSuccess: () => setEditing(false) });
      }}
    >
      <label className="sr-only" htmlFor="budget-input">
        Budget in dollars
      </label>
      <input
        id="budget-input"
        type="number"
        min={0}
        step={100}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="w-32 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
      />
      <button
        type="submit"
        disabled={setBudget.isPending}
        className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
      >
        Cancel
      </button>
    </form>
  );
}

export function CostPanel({ period, nurses }: CostPanelProps) {
  const reportQuery = useCostReport(period.id);

  if (reportQuery.isPending) return <AsyncState status="loading" label="Pricing the period" />;
  if (reportQuery.isError) {
    return (
      <AsyncState status="error" label="Could not price the period" error={reportQuery.error} />
    );
  }

  const { cost, budget, variance } = reportQuery.data;
  const nursesById = new Map(nurses.map((n) => [n.id, n]));
  const overBudget = variance !== undefined && variance.variance > 0;
  const ranked = cost.overtime.ranked.slice(0, 8);

  return (
    <div data-testid="cost-panel" className="grid grid-cols-2 gap-4">
      <div className="rounded-md border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm text-text-muted">
              {period.name} · {formatDate(period.startDate)} – {formatDate(period.endDate)}
            </p>
            <p className="mt-1 text-2xl font-semibold text-text" data-testid="cost-total">
              {formatDollars(cost.totals.total)}
            </p>
          </div>
          <BudgetEditor period={period} current={budget?.targetDollars} />
        </div>

        {variance !== undefined ? (
          <p className={`mt-1 text-sm ${overBudget ? 'text-danger' : 'text-success'}`}>
            {formatSignedDollars(variance.variance)} against a budget of{' '}
            {formatDollars(variance.targetDollars)}
            {variance.ratio !== null ? ` (${Math.round(variance.ratio * 100)}%)` : ''}
          </p>
        ) : (
          <p className="mt-1 text-sm text-text-muted">No budget set for this period.</p>
        )}

        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-text-muted">Hours</dt>
          <dd className="text-text">{formatHours(cost.totals.hours)}</dd>
          <dt className="text-text-muted">Base pay</dt>
          <dd className="text-text">{formatDollars(cost.totals.base)}</dd>
          <dt className="text-text-muted">Differentials</dt>
          <dd className="text-text">{formatDollars(cost.totals.differentials)}</dd>
          <dt className="text-text-muted">Overtime premium</dt>
          <dd className={cost.totals.overtimePremium > 0 ? 'text-warn' : 'text-text'}>
            {formatDollars(cost.totals.overtimePremium)}
          </dd>
        </dl>

        {cost.unpricedAssignments > 0 ? (
          <p className="mt-3 text-sm text-danger" data-testid="cost-unpriced">
            {cost.unpricedAssignments} shift{cost.unpricedAssignments === 1 ? '' : 's'} could not be
            priced: {cost.unpricedNurseIds.length} nurse
            {cost.unpricedNurseIds.length === 1 ? ' has' : 's have'} no pay rate. Set one under
            Settings › Pay.
          </p>
        ) : null}
        {cost.assignments.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">Nothing scheduled yet.</p>
        ) : null}
      </div>

      <div className="rounded-md border border-border bg-surface p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-text">Overtime concentration</h3>
          <p className="text-sm text-text-muted">
            {formatHours(cost.overtime.totalHours)} · {formatDollars(cost.overtime.totalPremium)}
          </p>
        </div>
        {ranked.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">No overtime in this period.</p>
        ) : (
          <>
            <p className="mt-1 text-xs text-text-muted">
              Top three carry {Math.round(cost.overtime.topThreeShare * 100)}% of overtime hours
              across {cost.overtime.nursesWithOvertime} nurse
              {cost.overtime.nursesWithOvertime === 1 ? '' : 's'} · Gini{' '}
              {cost.overtime.gini.toFixed(2)}
            </p>
            <table className="mt-2 w-full border-collapse text-sm" data-testid="overtime-table">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Nurse
                  </th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    OT hours
                  </th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    Premium
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Share
                  </th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((row) => {
                  const nurse = nursesById.get(row.nurseId);
                  return (
                    <tr key={row.nurseId} className="border-b border-border last:border-0">
                      <td className="py-1 pr-2 text-text">
                        {nurse ? `${nurse.firstName} ${nurse.lastName}` : row.nurseId}
                      </td>
                      <td className="py-1 pr-2 text-right text-text">{formatHours(row.hours)}</td>
                      <td className="py-1 pr-2 text-right text-text">
                        {formatDollars(row.premium)}
                      </td>
                      <td className="py-1">
                        <div className="flex items-center gap-2">
                          <div
                            aria-hidden
                            className="h-2 rounded-full bg-warn"
                            style={{ width: `${Math.max(4, Math.round(row.share * 100))}%` }}
                          />
                          <span className="text-xs text-text-muted">
                            {Math.round(row.share * 100)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
