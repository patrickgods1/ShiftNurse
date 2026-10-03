/**
 * Scheduled nursing hours per patient day against the unit's HPPD budget, for one period. The
 * Demand page and the Dashboard both show it, so "is this schedule over budget?" has one answer
 * wherever it is asked.
 */

import type { HppdReport, Id } from '@shiftnurse/core';
import { useScheduledHppd } from '../api-demand.js';
import { AsyncState } from './async-state.js';
import { LabelWithTip } from './field-help.js';

const TIP =
  'Nursing hours scheduled (every worked shift’s paid hours, standby left out) divided by patient ' +
  'days (the forecast census averaged over each day). Days without a census forecast are left ' +
  'out. The target is set on Settings › Acuity.';

/** "0.6 over target" / "0.4 under target" / "on target", within 0.05 hours. */
export function describeAgainstTarget(hppd: number, target: number): string {
  const gap = hppd - target;
  if (Math.abs(gap) < 0.05) return 'on target';
  return `${Math.abs(gap).toFixed(1)} ${gap > 0 ? 'over' : 'under'} target`;
}

function Body({ report }: { report: HppdReport }) {
  if (report.hppd === undefined) {
    return (
      <p className="text-sm text-text-muted">
        No census forecast covers this period yet. Enter one on the Demand page to see it.
      </p>
    );
  }
  if (report.nursingHours === 0) {
    return (
      <p className="text-sm text-text-muted">
        Nothing scheduled yet: generate the schedule to see its hours per patient day.
      </p>
    );
  }
  const target = report.targetHours;
  const tone =
    target === undefined ? 'text-text' : report.hppd > target + 0.05 ? 'text-warn' : 'text-text';
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{report.hppd.toFixed(1)}</p>
      <p className="text-sm text-text-muted">
        {target === undefined
          ? 'No HPPD target set (Settings › Acuity).'
          : `Target ${target.toFixed(1)} · ${describeAgainstTarget(report.hppd, target)}`}
      </p>
      <p className="text-xs text-text-muted">
        {Math.round(report.nursingHours)} nursing hours over {report.patientDays.toFixed(1)} patient
        days
        {report.unmeasuredDates.length > 0
          ? ` · ${report.unmeasuredDates.length} day${report.unmeasuredDates.length === 1 ? '' : 's'} without a census left out`
          : ''}
      </p>
    </div>
  );
}

export function HppdSummary({ periodId, title }: { periodId: Id; title: string }) {
  const query = useScheduledHppd(periodId);
  return (
    <div data-testid="hppd-summary" className="rounded-md border border-border bg-surface p-4">
      <p className="mb-1 text-sm text-text-muted">
        <LabelWithTip label={title} tip={TIP} />
      </p>
      {query.isPending ? (
        <AsyncState status="loading" label="Loading scheduled HPPD" />
      ) : query.isError ? (
        <AsyncState status="error" label="Could not load scheduled HPPD" error={query.error} />
      ) : (
        <Body report={query.data} />
      )}
    </div>
  );
}
