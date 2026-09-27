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
import { leaveHoursBetween } from '../../../rules/paid-leave.js';
import { type EncodeContext, HOURS, hoursExpr, type TimelineEntry } from '../context.js';

/**
 * An "at most" bound in the model's integer hundredths of an hour. Leave spread over a request's
 * days can make it fractional, so it rounds down (the rule rejects anything over), with a guard
 * against 40.000000001 flooring to 39.99.
 */
function atMostHours(hours: number): number {
  return Math.floor(hours * HOURS + 1e-6);
}

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
    const leave = ctx.model.ctx.paidLeaveByNurse.get(ctx.model.nurses[n]!.id);
    for (const week of weeks) {
      const inWeek = counted.filter((e) => within(e, week.start, week.end));
      const authorised = inWeek.some((e) => e.literal === null && e.assignment?.isOvertime);
      // Paid leave eats into the overtime threshold only where the contract counts it; it never
      // counts toward the absolute cap.
      const leaveHours = params.paidLeaveCountsTowardOvertime
        ? leaveHoursBetween(leave, week.start, week.end)
        : 0;
      const cap =
        params.requireOvertimeAuthorisation && !authorised
          ? Math.min(params.maxHoursPerWeek, params.overtimeThresholdHours - leaveHours)
          : params.maxHoursPerWeek;
      ctx.b.atMost(
        hoursExpr(inWeek),
        atMostHours(cap),
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
    const leave = ctx.model.ctx.paidLeaveByNurse.get(nurse.id);
    for (const pay of periods) {
      // Paid leave counts toward the contract, so it uses up part of the allowance.
      const leaveHours = params.paidLeaveCountsTowardHours
        ? leaveHoursBetween(leave, pay.start, pay.end)
        : 0;
      ctx.b.atMost(
        hoursExpr(counted.filter((e) => within(e, pay.start, pay.end))),
        atMostHours(target + params.overToleranceHours - leaveHours),
        `contracted hours: ${ctx.name(n)} pay period from ${pay.start} over ${target}h + tolerance`,
      );
    }
  }
}
