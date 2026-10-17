/**
 * `max-hours-per-week` and the over-contract half of `fte-target-hours`, as linear caps.
 *
 * The solver never marks a shift as authorised overtime or records a holdover, so a week may pass
 * the overtime threshold by the hours a constant's holdover adds, or without limit when a
 * constant is marked authorised overtime — exactly what the rule accepts.
 */

import { compareDates } from '../../../domain/time.js';
import {
  authorisedOvertimeHours,
  contractedHoursRule,
  judgedPayPeriods,
  maxHoursRule,
  overtimeThreshold,
  payPeriodsIn,
  workWeeksIn,
} from '../../../rules/hours-rules.js';
import { leaveHoursBetween } from '../../../rules/paid-leave.js';
import { asParams } from '../../../rules/registry.js';
import { isElsewhere } from '../../../schedule/elsewhere.js';
import {
  type EncodeContext,
  HOURS,
  hoursExpr,
  scheduledHoursExpr,
  type TimelineEntry,
} from '../context.js';

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
  const params = asParams(maxHoursRule, raw);
  const { period, unit } = ctx.input;
  const window = { start: period.startDate, end: period.endDate };
  const weeks = workWeeksIn(window, params.workWeekStartsOn);
  // Over the pay period, overtime gets its own constraint per pay period and the weeks keep only
  // the absolute cap; weekly, one constraint per week carries the tighter of the two.
  const payPeriods = params.overtimeByPayPeriod ? payPeriodsIn(window, unit, false) : [];
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const counted = ctx
      .timeline(n)
      .filter((e) => params.onCallCountsTowardHours || !e.shiftType.isOnCall);
    const leave = ctx.model.ctx.paidLeaveByNurse.get(ctx.model.nurses[n]!.id);
    /** The overtime cap on a window, or null when overtime there is already authorised. */
    const overtimeCap = (inWindow: TimelineEntry[], start: string, end: string) => {
      // Constants only: a variable is a draft shift, which never carries overtime or a holdover.
      const authorised = authorisedOvertimeHours(
        inWindow.filter((e) => e.literal === null).map((e) => e.assignment!),
      );
      if (!params.requireOvertimeAuthorisation || authorised === Number.POSITIVE_INFINITY) {
        return null;
      }
      // Paid leave eats into the overtime threshold only where the contract counts it; it never
      // counts toward the absolute cap.
      const leaveHours = params.paidLeaveCountsTowardOvertime
        ? leaveHoursBetween(leave, start as never, end as never)
        : 0;
      return overtimeThreshold(params) - leaveHours + authorised;
    };
    for (const week of weeks) {
      const inWeek = counted.filter((e) => within(e, week.start, week.end));
      const overtime = params.overtimeByPayPeriod
        ? null
        : overtimeCap(inWeek, week.start, week.end);
      const cap =
        overtime === null ? params.maxHoursPerWeek : Math.min(params.maxHoursPerWeek, overtime);
      ctx.b.atMost(
        hoursExpr(inWeek),
        atMostHours(cap),
        `weekly hours: ${ctx.name(n)} week of ${week.start} over ${cap}h`,
      );
    }
    for (const pay of payPeriods) {
      const inPay = counted.filter((e) => within(e, pay.start, pay.end));
      // A pay period with none of this schedule's shifts is not the rule's to judge.
      if (!inPay.some((e) => e.inPeriod)) continue;
      const cap = overtimeCap(inPay, pay.start, pay.end);
      if (cap === null) continue;
      ctx.b.atMost(
        hoursExpr(inPay),
        atMostHours(cap),
        `overtime: ${ctx.name(n)} pay period from ${pay.start} over ${cap}h`,
      );
    }
  }
}

export function encodeContractCap(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(contractedHoursRule, raw);
  const { period, unit, historyFrom } = ctx.input;
  const periods = judgedPayPeriods(
    { start: period.startDate, end: period.endDate },
    unit,
    params.onlyCompletePayPeriods,
    historyFrom,
  );
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const nurse = ctx.model.nurses[n]!;
    const target = nurse.contractedHoursPerPeriod;
    if (!nurse.active || target <= 0) continue;
    // As the rule counts: the published tail only once `historyFrom` says it is whole, and never
    // another unit's shifts, which are that unit's contract.
    const counted = ctx
      .timeline(n)
      .filter(
        (e) =>
          (e.inPeriod || historyFrom !== undefined) &&
          !isElsewhere(e.shiftType) &&
          (params.onCallCountsTowardHours || !e.shiftType.isOnCall),
      );
    const leave = ctx.model.ctx.paidLeaveByNurse.get(nurse.id);
    for (const pay of periods) {
      const inPay = counted.filter((e) => within(e, pay.start, pay.end));
      // The rule calls a pay period over only when a shift of this schedule is in it: history
      // alone past the contract is not this schedule's to fix, and capping it would be infeasible.
      if (!inPay.some((e) => e.inPeriod)) continue;
      // Paid leave counts toward the contract, so it uses up part of the allowance.
      const leaveHours = params.paidLeaveCountsTowardHours
        ? leaveHoursBetween(leave, pay.start, pay.end)
        : 0;
      ctx.b.atMost(
        scheduledHoursExpr(inPay),
        atMostHours(target + params.overToleranceHours - leaveHours),
        `contracted hours: ${ctx.name(n)} pay period from ${pay.start} over ${target}h + tolerance`,
      );
    }
  }
}
