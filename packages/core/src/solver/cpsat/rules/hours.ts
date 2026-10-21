/**
 * `max-hours-per-week` and the over-contract half of `fte-target-hours`, as linear caps.
 * A constant marked authorised overtime is left out of the contract cap, as the rule leaves it.
 * The weekly caps count whole minutes when the unit's pay attribution is loaded (a night split at
 * the week's edge by the clock, 21 Q1); the contract cap stays in hundredths of declared hours.
 *
 * The solver never marks a shift as authorised overtime or records a holdover, so a week may pass
 * the overtime threshold by the hours a constant's holdover adds, or without limit when a
 * constant is marked authorised overtime — exactly what the rule accepts.
 */

import { addDays, compareDates, type IsoDate, MINUTES_PER_HOUR } from '../../../domain/time.js';
import {
  authorisedOvertimeHours,
  contractedHoursRule,
  type DateWindow,
  judgedPayPeriods,
  judgedSpan,
  maxHoursRule,
  overtimeThreshold,
  payPeriodsIn,
  type WindowReading,
  workWeekFor,
  workWeeksIn,
} from '../../../rules/hours-rules.js';
import { leaveHoursBetween } from '../../../rules/paid-leave.js';
import { asParams } from '../../../rules/registry.js';
import { isElsewhere } from '../../../schedule/elsewhere.js';
import { realMinutesIn } from '../../../schedule/real-minutes.js';
import { minutesInWindow, windowDayOf } from '../../../schedule/window-split.js';
import { type Expr, expr } from '../builder.js';
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

function within(e: TimelineEntry, start: IsoDate, end: IsoDate): boolean {
  return compareDates(e.date, start) >= 0 && compareDates(e.date, end) <= 0;
}

/**
 * Whether an entry starts in the window dated [start, end] opening at `startMinute`
 * (`windowDayOf`): the weekly caps' membership, which at 0 is "is dated in it".
 */
function startsWithin(e: TimelineEntry, start: IsoDate, end: IsoDate, startMinute: number) {
  const day = windowDayOf(e.window.startMinute, startMinute);
  return compareDates(day, start) >= 0 && compareDates(day, end) <= 0;
}

/** How the weekly caps read a window: the rule context's attribution and clock, and its start. */
type WeekReading = WindowReading & { startMinute: number };

/**
 * An "at most" bound in whole minutes, for the weekly caps when they count a shift by the clock.
 * Rounded down with the same guard as `atMostHours`.
 */
function atMostMinutes(hours: number): number {
  return Math.floor(hours * MINUTES_PER_HOUR + 1e-6);
}

/**
 * Σ worked minutes in [start, end] as `max-hours-per-week` counts them with a pay attribution
 * (`RuleContext.overtimeWindowAttribution`): real minutes, a night crossing the window's edge
 * split at its boundary by the clock. Kept apart from `hoursExpr`, which is in hundredths of an
 * hour: a night's 300 minutes before midnight are not a whole number of hundredths once the clock
 * changes, and mixing the two scales in one constraint would be silently wrong.
 */
function minutesExpr(
  entries: readonly TimelineEntry[],
  start: IsoDate,
  end: IsoDate,
  reading: WeekReading,
): Expr {
  const e = expr();
  const tz = reading.dstTransitions;
  const next = addDays(end, 1);
  for (const entry of entries) {
    // A constant's window is what was worked, holdover included; a variable's has none.
    let minutes: number;
    if (reading.overtimeWindowAttribution !== 'start') {
      minutes = minutesInWindow(entry, start, next, tz, reading.startMinute);
    } else {
      minutes = startsWithin(entry, start, end, reading.startMinute)
        ? realMinutesIn(entry.window, tz)
        : 0;
    }
    if (minutes === 0) continue;
    if (entry.literal === null) e.constant += minutes;
    else e.terms.push([entry.literal, minutes]);
  }
  return e;
}

/** Whether an entry adds to [start, end] as the rule counts it: starts in it, or worked in it. */
function counts(entry: TimelineEntry, start: IsoDate, end: IsoDate, reading: WeekReading) {
  if (startsWithin(entry, start, end, reading.startMinute)) return true;
  if (reading.overtimeWindowAttribution !== 'clock') return false;
  if (compareDates(windowDayOf(entry.window.startMinute, reading.startMinute), end) > 0) {
    return false;
  }
  const next = addDays(end, 1);
  return minutesInWindow(entry, start, next, reading.dstTransitions, reading.startMinute) > 0;
}

export function encodeWeeklyHours(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(maxHoursRule, raw);
  const { period, unit } = ctx.input;
  const window = { start: period.startDate, end: period.endDate };
  // With the unit's pay attribution the rule counts real minutes, a night split by the clock
  // (21 Q1), so these caps are in minutes; without it, hundredths of declared hours as before.
  const byMinutes = ctx.model.ctx.overtimeWindowAttribution !== undefined;
  const atMost = (hours: number) => (byMinutes ? atMostMinutes(hours) : atMostHours(hours));
  // Each nurse's windows come from her own work week (`workWeekFor`): the unit's, or the night
  // nurses' when the rule sets one. At most two grids, built once.
  const grids = new Map<string, { weeks: DateWindow[]; payPeriods: DateWindow[] }>();
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const week = workWeekFor(ctx.model.nurses[n]!, params);
    const key = `${week.startsOn}:${week.startMinute}`;
    let grid = grids.get(key);
    if (grid === undefined) {
      // The windows holding the schedule's first and last instants, as the rule selects them.
      const span = judgedSpan(window, week.startMinute);
      grid = {
        weeks: workWeeksIn(span, week.startsOn),
        // Over the pay period, overtime gets its own constraint per pay period and the weeks keep
        // only the absolute cap; weekly, one constraint per week carries the tighter of the two.
        payPeriods: params.overtimeByPayPeriod ? payPeriodsIn(span, unit, false) : [],
      };
      grids.set(key, grid);
    }
    const { weeks, payPeriods } = grid;
    const reading: WeekReading = {
      overtimeWindowAttribution: ctx.model.ctx.overtimeWindowAttribution,
      dstTransitions: ctx.model.ctx.dstTransitions,
      startMinute: week.startMinute,
    };
    const workedIn = (inWindow: TimelineEntry[], start: IsoDate, end: IsoDate) =>
      byMinutes ? minutesExpr(inWindow, start, end, reading) : hoursExpr(inWindow);
    const counted = ctx
      .timeline(n)
      .filter((e) => params.onCallCountsTowardHours || !e.shiftType.isOnCall);
    const leave = ctx.model.ctx.paidLeaveByNurse.get(ctx.model.nurses[n]!.id);
    /** The overtime cap on a window, or null when overtime there is already authorised. */
    const overtimeCap = (inWindow: TimelineEntry[], start: IsoDate, end: IsoDate) => {
      // Constants only: a variable is a draft shift, which never carries overtime or a holdover.
      // Only rows that start in the window authorise it, as in the rule.
      const authorised = authorisedOvertimeHours(
        inWindow
          .filter((e) => e.literal === null && startsWithin(e, start, end, reading.startMinute))
          .map((e) => e.assignment!),
      );
      if (!params.requireOvertimeAuthorisation || authorised === Number.POSITIVE_INFINITY) {
        return null;
      }
      // Paid leave eats into the overtime threshold only where the contract counts it; it never
      // counts toward the absolute cap.
      const leaveHours = params.paidLeaveCountsTowardOvertime
        ? leaveHoursBetween(leave, start, end)
        : 0;
      return overtimeThreshold(params) - leaveHours + authorised;
    };
    for (const week of weeks) {
      const inWeek = counted.filter((e) => counts(e, week.start, week.end, reading));
      const overtime = params.overtimeByPayPeriod
        ? null
        : overtimeCap(inWeek, week.start, week.end);
      const cap =
        overtime === null ? params.maxHoursPerWeek : Math.min(params.maxHoursPerWeek, overtime);
      ctx.b.atMost(
        workedIn(inWeek, week.start, week.end),
        atMost(cap),
        `weekly hours: ${ctx.name(n)} week of ${week.start} over ${cap}h`,
      );
    }
    for (const pay of payPeriods) {
      const inPay = counted.filter((e) => counts(e, pay.start, pay.end, reading));
      // A pay period with none of this schedule's shifts is not the rule's to judge.
      if (!inPay.some((e) => e.inPeriod)) continue;
      const cap = overtimeCap(inPay, pay.start, pay.end);
      if (cap === null) continue;
      ctx.b.atMost(
        workedIn(inPay, pay.start, pay.end),
        atMost(cap),
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
      // A shift marked authorised overtime sits outside the ceiling, as in the rule. Only a
      // constant can carry the flag: the solvers never write an overtime row.
      const inPay = counted.filter(
        (e) => within(e, pay.start, pay.end) && !(e.literal === null && e.assignment?.isOvertime),
      );
      // The rule calls a pay period over only when a straight-time shift of this schedule is in
      // it: history alone past the contract is not this schedule's to fix, and capping it would
      // be infeasible.
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
