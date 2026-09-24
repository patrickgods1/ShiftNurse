/**
 * `max-hours-per-week` and the over-contract half of `fte-target-hours`, as linear caps.
 *
 * The solver never marks a shift as authorised overtime, so a week may pass the overtime
 * threshold only if a locked or published shift in it already carries that authorisation —
 * exactly when the rule would accept it.
 */

import { compareDates } from '../../../domain/time.js';
import {
  type ContractedHoursParams,
  type MaxHoursParams,
  payPeriodsIn,
  workWeeksIn,
} from '../../../rules/hours-rules.js';
import { type EncodeContext, HOURS, hoursExpr, type TimelineEntry } from '../context.js';

function within(e: TimelineEntry, start: string, end: string): boolean {
  return compareDates(e.date, start as never) >= 0 && compareDates(e.date, end as never) <= 0;
}

export function encodeWeeklyHours(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = raw as unknown as MaxHoursParams;
  const { period } = ctx.input;
  const weeks = workWeeksIn(
    { start: period.startDate, end: period.endDate },
    params.workWeekStartsOn,
  );
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const counted = ctx
      .timeline(n)
      .filter((e) => params.onCallCountsTowardHours || !e.shiftType.isOnCall);
    for (const week of weeks) {
      const inWeek = counted.filter((e) => within(e, week.start, week.end));
      const authorised = inWeek.some((e) => e.literal === null && e.assignment?.isOvertime);
      const cap =
        params.requireOvertimeAuthorisation && !authorised
          ? Math.min(params.maxHoursPerWeek, params.overtimeThresholdHours)
          : params.maxHoursPerWeek;
      ctx.b.atMost(
        hoursExpr(inWeek),
        cap * HOURS,
        `weekly hours: ${ctx.name(n)} week of ${week.start} over ${cap}h`,
      );
    }
  }
}

export function encodeContractCap(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = raw as unknown as ContractedHoursParams;
  const { period, unit } = ctx.input;
  const periods = payPeriodsIn(
    { start: period.startDate, end: period.endDate },
    unit,
    params.onlyCompletePayPeriods,
  );
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const nurse = ctx.model.nurses[n]!;
    const target = nurse.contractedHoursPerPeriod;
    if (!nurse.active || target <= 0) continue;
    const counted = ctx
      .timeline(n)
      .filter((e) => e.inPeriod && (params.onCallCountsTowardHours || !e.shiftType.isOnCall));
    for (const pay of periods) {
      ctx.b.atMost(
        hoursExpr(counted.filter((e) => within(e, pay.start, pay.end))),
        (target + params.overToleranceHours) * HOURS,
        `contracted hours: ${ctx.name(n)} pay period from ${pay.start} over ${target}h + tolerance`,
      );
    }
  }
}
