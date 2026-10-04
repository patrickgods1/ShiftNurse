/**
 * The running price of the period, a pill in the status row with the full breakdown opening below
 * it. It re-prices after every grid edit (the mutations invalidate the cost report alongside
 * validation), which is what "dollar impact on every decision" means for a manager dragging shifts
 * around: the number moves as they move the shift.
 *
 * Unpriced shifts are called out in the same breath as the total. A total that silently omits
 * twelve shifts because three nurses have no rate is worse than no total at all.
 */

import type { PeriodCostReport } from '@shared/api.js';
import { formatDollars, formatHours, formatSignedDollars } from '../../money.js';
import { PreviewTag } from './preview-tag.js';
import type { StatusItem } from './status-row.js';

/** "+$308k": the pill is one line, so thousands are abbreviated; the detail has the exact sums. */
function compactSigned(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return abs >= 1000
    ? `${sign}$${Math.round(abs / 1000).toLocaleString('en-US')}k`
    : `${sign}${formatDollars(abs)}`;
}

interface CostPillProps {
  report: PeriodCostReport | undefined;
  /** The previewed variation's name, when the report is that variation's. */
  previewLabel?: string | undefined;
}

export function costPill({ report, previewLabel }: CostPillProps): StatusItem | undefined {
  if (!report) return undefined;
  const { cost, variance } = report;
  const unpriced = cost.unpricedAssignments;
  const overBudget = variance !== undefined && variance.variance > 0;
  const parts = [
    formatDollars(cost.totals.total),
    variance !== undefined ? `${compactSigned(variance.variance)} vs budget` : 'no budget set',
    ...(cost.overtime.totalHours > 0 ? [`${formatHours(cost.overtime.totalHours)} overtime`] : []),
    // Never a silent zero: a total that omits shifts says so in the headline.
    ...(unpriced > 0 ? [`${unpriced} unpriced`] : []),
  ];
  return {
    id: 'cost',
    testId: 'cost-summary',
    tone: unpriced > 0 || overBudget ? 'danger' : 'muted',
    label: parts.join(' · '),
    previewTag: <PreviewTag label={previewLabel} />,
    detail: <CostDetail report={report} />,
  };
}

function CostDetail({ report }: { report: PeriodCostReport }) {
  const { cost, variance } = report;
  const overtime = cost.overtime;
  const overBudget = variance !== undefined && variance.variance > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
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
