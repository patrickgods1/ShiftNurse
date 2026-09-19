/**
 * The running price of the period, directly under the compliance readout. It re-prices after
 * every grid edit (the mutations invalidate the cost report alongside validation), which is
 * what "dollar impact on every decision" means for a manager dragging shifts around: the number
 * moves as they move the shift.
 *
 * Unpriced shifts are called out in the same breath as the total. A total that silently omits
 * twelve shifts because three nurses have no rate is worse than no total at all.
 */

import type { PeriodCostReport } from '@shared/api.js';
import { formatDollars, formatHours, formatSignedDollars } from '../../money.js';

interface CostSummaryProps {
  report: PeriodCostReport | undefined;
}

export function CostSummary({ report }: CostSummaryProps) {
  if (!report) return null;
  const { cost, variance } = report;
  const overtime = cost.overtime;
  const overBudget = variance !== undefined && variance.variance > 0;

  return (
    <div
      data-testid="cost-summary"
      className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
    >
      <p className="font-medium text-text">
        {formatDollars(cost.totals.total)}
        <span className="ml-1 font-normal text-text-muted">
          for {formatHours(cost.totals.hours)}
        </span>
      </p>
      {variance !== undefined ? (
        <p className={overBudget ? 'text-danger' : 'text-success'}>
          {formatSignedDollars(variance.variance)} vs budget {formatDollars(variance.targetDollars)}
        </p>
      ) : (
        <p className="text-text-muted">No budget set</p>
      )}
      <p className={overtime.totalHours > 0 ? 'text-warn' : 'text-text-muted'}>
        {formatHours(overtime.totalHours)} overtime · {formatDollars(overtime.totalPremium)} premium
        {overtime.nursesWithOvertime > 0
          ? ` across ${overtime.nursesWithOvertime} nurse${overtime.nursesWithOvertime === 1 ? '' : 's'}`
          : ''}
      </p>
      {cost.unpricedAssignments > 0 ? (
        <p className="text-danger" data-testid="cost-unpriced">
          {cost.unpricedAssignments} shift{cost.unpricedAssignments === 1 ? '' : 's'} unpriced — set
          pay rates in Settings › Pay
        </p>
      ) : null}
    </div>
  );
}
