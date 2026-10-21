/**
 * Schedule costing — prices every in-period assignment, rolls the result up per nurse and for
 * the unit, and prices a single candidate assignment in context.
 *
 * See `types.ts` for the pay model this implements. The one structural point worth restating:
 * overtime is a property of a nurse's *week* (or pay period), not of a shift, so costing walks each nurse's
 * full timeline (lookback tail included, exactly as the max-hours rule does) before any shift
 * can be priced. That is also why `marginalCost` re-costs the nurse rather than pricing the
 * candidate in isolation — the shift you add on Sunday can turn Wednesday into overtime.
 */

import type {
  Assignment,
  Differential,
  DifferentialKind,
  Id,
  Nurse,
  OvertimeRule,
} from '../domain/entities.js';
import {
  addDays,
  compareDates,
  crossesMidnight,
  dayNumber,
  fromDayNumber,
  type IsoDate,
  isWeekendWindow,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  parseTimeOfDay,
  type ShiftWindow,
  shiftWindow,
  type Weekday,
  type WeekendDefinition,
  weekdayOf,
} from '../domain/time.js';
import { gini } from '../fairness/distribution.js';
import { payPeriodIndex, payPeriodWindow, workWeekFor } from '../rules/hours-rules.js';
import type { PaidLeaveCredit } from '../rules/paid-leave.js';
import { isWorked } from '../rules/types.js';
import { workedStretches } from '../schedule/holdover.js';
import { attributedHolidayDates, holidayMinutesOn } from '../schedule/holiday-attribution.js';
import { type DstTransition, realMinutesIn } from '../schedule/real-minutes.js';
import { type AssignmentView, ScheduleView } from '../schedule/view.js';
import { minutesBeforeEdge, realOffset, windowDayOf } from '../schedule/window-split.js';
import { roundCents, sumCents } from './money.js';
import { resolvePayRate } from './rates.js';
import {
  type AssignmentCost,
  type BudgetVariance,
  type CostContext,
  type CostLine,
  type CostLineKind,
  type CostTotals,
  DIFFERENTIAL_ORDER,
  type MarginalCost,
  type NurseCost,
  type NurseOvertime,
  type OvertimeConcentration,
  type ScheduleCost,
} from './types.js';

// ---------------------------------------------------------------------------
// Overtime attribution
// ---------------------------------------------------------------------------

/**
 * A run of a shift's minutes paid at one overtime multiplier, `from` minutes into the shift.
 * Bands carry their own start because they are not always the end of the shift: a Saturday
 * night's evening hours can be the old week's overtime and its Sunday hours straight time.
 */
interface OvertimeBand {
  from: number;
  minutes: number;
  multiplier: number;
}

/** Minutes into a shift, `[from, to)`, that one rule makes overtime. */
interface OvertimeSpan {
  from: number;
  to: number;
}

/**
 * The minutes a view is paid for: the real elapsed minutes of its worked window, holdover
 * included, on the host's clock (`tz`, D19), so the fall-back night is 780 and the spring one 660.
 * Attribution counts integers because `durationHours` and `holdoverMinutes / 60` are not exact in
 * binary: a week of 721 + 724 + 538 + 417 minutes is exactly 40 hours, yet summed as float hours
 * it ran 7e-15 past the threshold and raised a phantom overtime line. The one conversion, so a
 * different count of a view's minutes changes here only.
 */
function paidMinutesOf(view: AssignmentView, tz: readonly DstTransition[]): number {
  return realMinutesIn(view.window, tz);
}

/** The real minutes a view was scheduled for: its declared window, no holdover. */
function scheduledMinutesOf(view: AssignmentView, tz: readonly DstTransition[]): number {
  return realMinutesIn(shiftWindow(view.assignment.date, view.shiftType), tz);
}

/** A run of windows (weeks or pay periods): the window a date is in, and the next one's start. */
interface WindowCalendar {
  windowOf: (date: IsoDate) => IsoDate;
  nextStart: (date: IsoDate) => IsoDate;
}

/** Weeks starting on `startsOn`: the nurse's own (`workWeekFor`). */
function weekCalendar(startsOn: Weekday): WindowCalendar {
  const windowOf = (d: IsoDate) => workWeekStart(d, startsOn);
  return { windowOf, nextStart: (d) => addDays(windowOf(d), 7) };
}

function payPeriodCalendar(ctx: CostContext): WindowCalendar {
  const periodOf = (d: IsoDate) => payPeriodWindow(payPeriodIndex(d, ctx.unit), ctx.unit);
  return { windowOf: (d) => periodOf(d).start, nextStart: (d) => addDays(periodOf(d).end, 1) };
}

/**
 * The overtime rules that price this nurse: above 1×, and for their kind. A unit's rules for its
 * 72/80 and Baylor nurses sit beside its standard ones (38 U.S.C. §§ 7456, 7456A).
 */
function activeRulesFor(timeline: readonly AssignmentView[], ctx: CostContext): OvertimeRule[] {
  const kind = timeline[0]?.nurse.scheduleKind ?? 'standard';
  return ctx.overtimeRules.filter(
    (rule) =>
      rule.multiplier > 1 &&
      (rule.scheduleKinds === undefined || rule.scheduleKinds.includes(kind)),
  );
}

/** A rule's threshold in whole minutes. */
function thresholdMinutesOf(rule: OvertimeRule): number {
  return Math.round(rule.thresholdHours * MINUTES_PER_HOUR);
}

/** The date a work week containing `date` starts on. */
function workWeekStart(date: IsoDate, startsOn: number): IsoDate {
  return addDays(date, -((weekdayOf(date) - startsOn + 7) % 7));
}

/**
 * Overtime spans per worked view under one rule, against a threshold in minutes. `windowOf`
 * names the window a shift's minutes accrue in, by a date: the shift's own start date for a
 * workday, or the first date of its week or pay period. Minutes accrue in chronological order,
 * since the timeline is sorted by shift start. So earlier hours use up the threshold first, only
 * the shifts that cross it carry overtime, and only the minutes past it: the *end* of the shift,
 * `[countable − over, paid)`. Tail views accrue and are reported like any other;
 * `overtimeStarts` decides whether its caller sees them. `counts` leaves a view out of the
 * accrual altogether (the seventh-day rule). `minutesOf` is what a view adds to the accrual (its
 * countable minutes): its straight minutes alone, for a weekly rule that does not pyramid.
 *
 * `startMinute` (weekly and pay-period rules) places windows at the work week's start time: a
 * view accrues in the window its start falls in (`windowDayOf`), not its date's. Absent (daily
 * bases), a view's window is its date's.
 *
 * `split` (weekly and pay-period rules under `'clock'` attribution, D17) names the date the next
 * window starts. A shift whose worked window runs past that midnight gives its minutes before it
 * to its own window and the rest to the next, each judged there (29 CFR 778.104: each workweek
 * stands alone). A shift crosses at most one edge: windows are at least a week, shifts at most a
 * day and a half. The first piece's overtime is its own last minutes, `[a − over, a)`; the second
 * piece's runs to the shift's end, as an unsplit shift's does.
 */
function windowOvertime(
  timeline: readonly AssignmentView[],
  threshold: number,
  windowOf: (date: IsoDate) => IsoDate,
  leave: readonly PaidLeaveCredit[] | undefined,
  counts: ((view: AssignmentView) => boolean) | undefined,
  minutesOf: (view: AssignmentView) => number,
  tz: readonly DstTransition[],
  split?: (date: IsoDate) => IsoDate,
  startMinute?: number,
): Map<AssignmentView, OvertimeSpan[]> {
  // Counted leave uses up the threshold first: a window's PTO day is not attributable to one
  // shift, and putting it first is what makes the shifts that cross the threshold the overtime
  // ones.
  const leaveByWindow = new Map<IsoDate, number>();
  for (const c of leave ?? []) {
    const window = windowOf(c.date);
    leaveByWindow.set(
      window,
      (leaveByWindow.get(window) ?? 0) + Math.round(c.hours * MINUTES_PER_HOUR),
    );
  }
  const runningByWindow = new Map<IsoDate, number>();
  // Adds `minutes` to a window and returns how many of them are past the threshold.
  const accrue = (window: IsoDate, minutes: number) => {
    const before = runningByWindow.get(window) ?? leaveByWindow.get(window) ?? 0;
    const after = before + minutes;
    runningByWindow.set(window, after);
    return Math.max(0, after - Math.max(threshold, before));
  };
  const out = new Map<AssignmentView, OvertimeSpan[]>();
  for (const view of timeline) {
    if (!isWorked(view) || (counts !== undefined && !counts(view))) continue;
    const date =
      startMinute === undefined
        ? view.assignment.date
        : windowDayOf(view.window.startMinute, startMinute);
    const countable = minutesOf(view);
    const paid = paidMinutesOf(view, tz);
    const next = split?.(date);
    const a =
      next === undefined
        ? countable
        : Math.min(countable, minutesBeforeEdge(view, next, tz, startMinute));
    const spans: OvertimeSpan[] = [];
    if (a < countable && next !== undefined) {
      const overA = accrue(windowOf(date), a);
      if (overA > 0) spans.push({ from: a - overA, to: a });
      const overB = accrue(windowOf(next), countable - a);
      if (overB > 0) spans.push({ from: countable - overB, to: paid });
    } else {
      const over = accrue(windowOf(date), countable);
      if (over > 0) spans.push({ from: countable - over, to: paid });
    }
    if (spans.length > 0) out.set(view, spans);
  }
  return out;
}

/**
 * Whether a shift falls on the seventh consecutive day worked in its work week: the week's last
 * day, with a worked shift dated on every day of it. Lookback shifts count toward the six before.
 */
function seventhDayTest(
  timeline: readonly AssignmentView[],
  startsOn: number,
): (view: AssignmentView) => boolean {
  const worked = new Set<IsoDate>();
  for (const view of timeline) if (isWorked(view)) worked.add(view.assignment.date);
  return (view) => {
    const date = view.assignment.date;
    if ((weekdayOf(date) - startsOn + 7) % 7 !== 6) return false;
    for (let back = 1; back <= 6; back++) if (!worked.has(addDays(date, -back))) return false;
    return true;
  };
}

/**
 * Whether a shift falls on a date worked beyond the nurse's `scheduledDaysPerWeek` in its work
 * week: the week's worked dates are counted in order, lookback included, and the (n+1)th and
 * later are extra. A nurse with no scheduled days on file has none.
 */
function extraDayTest(
  timeline: readonly AssignmentView[],
  startsOn: number,
): (view: AssignmentView) => boolean {
  const scheduled = timeline[0]?.nurse.scheduledDaysPerWeek;
  if (scheduled === undefined) return () => false;
  const datesByWeek = new Map<IsoDate, Set<IsoDate>>();
  const extra = new Set<IsoDate>();
  for (const view of timeline) {
    if (!isWorked(view)) continue;
    const date = view.assignment.date;
    const week = workWeekStart(date, startsOn);
    const dates = datesByWeek.get(week) ?? new Set<IsoDate>();
    datesByWeek.set(week, dates);
    if (dates.has(date)) continue;
    dates.add(date);
    if (dates.size > scheduled) extra.add(date);
  }
  return (view) => extra.has(view.assignment.date);
}

/**
 * Whether a shift falls on a tour day (`'only'`) or on a day without one (`'except'`): a date on
 * which the nurse has a worked tour, lookback included. For a 72/80 nurse a tour is any shift
 * scheduled for 12 hours; the declared length decides, never the worked one, so an 8 held over
 * four hours is not a tour (§ 7456A(c)(1)). For a Baylor nurse it is the weekend by the calendar:
 * a Saturday, a Sunday, or a Friday whose shift runs into Saturday. § 7456(b)(3)(A) judges past 8
 * only "on a day other than a Saturday or Sunday" and the weekend by its 24 hours, whoever was
 * scheduled, so this is not `isBaylorTour`, which leaves out a pickup for the premiums' sake.
 */
function tourDayTest(
  timeline: readonly AssignmentView[],
  mode: 'only' | 'except',
): (view: AssignmentView) => boolean {
  const tourDates = new Set<IsoDate>();
  for (const view of timeline) {
    if (!isWorked(view)) continue;
    const tour = isBaylorPlan(view.nurse) ? isBaylorWeekendDay(view) : view.scheduledHours === 12;
    if (tour) tourDates.add(view.assignment.date);
  }
  return (view) => tourDates.has(view.assignment.date) === (mode === 'only');
}

/**
 * The real minutes of a shift's first `minutes` worked minutes inside each weekend window they
 * touch, keyed by the minute the window opens. By the clock, so a Friday 19:00–07:00 night gives 7
 * hours to the weekend opening Saturday 00:00, and capped at the minutes asked for, so a shift
 * that does not pyramid offers only its straight minutes. The window's edges are wall minutes and
 * the count real ones, so each edge is measured as real minutes from the shift's start.
 */
function weekendMinutes(
  view: AssignmentView,
  def: WeekendDefinition,
  minutes: number,
  tz: readonly DstTransition[],
): Map<number, number> {
  const start = view.window.startMinute;
  const end = view.window.endMinute;
  const out = new Map<number, number>();
  // A week back: a window opening up to six days before the shift may still be open.
  for (let day = Math.floor(start / MINUTES_PER_DAY) - 7; day * MINUTES_PER_DAY < end; day++) {
    if (weekdayOf(fromDayNumber(day)) !== def.startWeekday) continue;
    const opens = day * MINUTES_PER_DAY + def.startMinute;
    const from = realOffset(start, end, opens, tz);
    const to = Math.min(minutes, realOffset(start, end, opens + def.durationMinutes, tz));
    if (to > from) out.set(opens, to - from);
  }
  return out;
}

/**
 * Overtime minutes per worked view past `threshold` minutes inside one weekend window, accrued in
 * chronological order like `windowOvertime`. Only a shift's in-window minutes accrue, and its
 * overtime is as many minutes as its in-window minutes run past the threshold. Those are reported
 * as the end of the shift, as every basis's are: for a Sunday night running out of the weekend the
 * count is right though the clock hours it names are Monday's.
 */
function weekendOvertime(
  timeline: readonly AssignmentView[],
  threshold: number,
  def: WeekendDefinition,
  minutesOf: (view: AssignmentView) => number,
  tz: readonly DstTransition[],
): Map<AssignmentView, number> {
  const out = new Map<AssignmentView, number>();
  const runningByWeekend = new Map<number, number>();
  for (const view of timeline) {
    if (!isWorked(view)) continue;
    let over = 0;
    for (const [weekend, minutes] of weekendMinutes(view, def, minutesOf(view), tz)) {
      const before = runningByWeekend.get(weekend) ?? 0;
      const after = before + minutes;
      runningByWeekend.set(weekend, after);
      over += Math.max(0, after - Math.max(threshold, before));
    }
    if (over > 0) out.set(view, over);
  }
  return out;
}

/** Whether a rule accrues over a window of days, and so can be told not to pyramid. */
function isWindowBasis(rule: OvertimeRule): boolean {
  return rule.basis === 'weekly' || rule.basis === 'pay_period' || rule.basis === 'weekend';
}

/**
 * Where one rule makes each in-period view's overtime, as spans of minutes into the shift. Every
 * basis but a split weekly or pay-period shift gives one span running to the shift's end. Every
 * basis is spelled out, so an unhandled one fails to compile here rather than falling through to
 * the weekly window.
 *
 * `countedOf` gives what a window-basis rule (weekly, pay-period, weekend) counts of a view, as
 * `attributeOvertime` resolved its pyramiding: every paid minute when it stacks, or only the
 * minutes before any other basis's overtime starts when it does not, so its overtime falls on the
 * last straight minutes, just before the daily premium ones. Other bases ignore it. With
 * `withTail`, lookback views get a start too. Those only ever feed the straight minutes: a previous
 * period's shift is not this schedule's cost, but its daily premium hours are still not weekly
 * hours.
 */
function overtimeStarts(
  rule: OvertimeRule,
  timeline: readonly AssignmentView[],
  ctx: CostContext,
  leave: readonly PaidLeaveCredit[] | undefined,
  isSeventhDay: (view: AssignmentView) => boolean,
  tz: readonly DstTransition[],
  countedOf?: (view: AssignmentView) => number,
  withTail = false,
): Map<AssignmentView, OvertimeSpan[]> {
  const paidOf = (view: AssignmentView) => paidMinutesOf(view, tz);
  const minutesOf = isWindowBasis(rule) && countedOf ? countedOf : paidOf;
  const threshold = thresholdMinutesOf(rule);
  const toEnd = (view: AssignmentView, from: number): OvertimeSpan[] => [
    { from, to: paidOf(view) },
  ];
  const fromWeekend = (over: Map<AssignmentView, number>) =>
    new Map([...over].map(([view, minutes]) => [view, toEnd(view, minutesOf(view) - minutes)]));
  // Weekly and pay-period rules put each hour in the window it was worked unless the unit counts
  // shifts by their start (D17).
  const byClock = (ctx.overtimeWindowAttribution ?? 'clock') === 'clock';
  // Weekly and pay-period windows are the nurse's own: a night nurse's when the unit sets one.
  const week = workWeekFor(timeline[0]?.nurse, ctx);
  let starts: Map<AssignmentView, OvertimeSpan[]>;
  switch (rule.basis) {
    case 'daily':
      // A workday is the shifts dated on it: a night belongs to the day it started, never split.
      starts = windowOvertime(
        timeline,
        threshold,
        (d) => d,
        undefined,
        rule.tourDays === undefined ? undefined : tourDayTest(timeline, rule.tourDays),
        minutesOf,
        tz,
      );
      break;
    case 'seventh_day':
      starts = windowOvertime(
        timeline,
        threshold,
        (d) => d,
        undefined,
        isSeventhDay,
        minutesOf,
        tz,
      );
      break;
    case 'beyond_scheduled_days':
      starts = windowOvertime(
        timeline,
        threshold,
        (d) => d,
        undefined,
        extraDayTest(timeline, ctx.workWeekStartsOn),
        minutesOf,
        tz,
      );
      break;
    case 'weekly': {
      const weeks = weekCalendar(week.startsOn);
      starts = windowOvertime(
        timeline,
        threshold,
        weeks.windowOf,
        leave,
        undefined,
        minutesOf,
        tz,
        byClock ? weeks.nextStart : undefined,
        week.startMinute,
      );
      break;
    }
    case 'weekend':
      // Paid leave is not "service performed" in the weekend (§ 7456(b)(3)(A)), so none counts.
      // The weekend is already counted by the clock (`weekendMinutes`).
      starts = fromWeekend(
        weekendOvertime(timeline, threshold, ctx.weekendDefinition, minutesOf, tz),
      );
      break;
    case 'pay_period': {
      const periods = payPeriodCalendar(ctx);
      starts = windowOvertime(
        timeline,
        threshold,
        periods.windowOf,
        leave,
        undefined,
        minutesOf,
        tz,
        byClock ? periods.nextStart : undefined,
        week.startMinute,
      );
      break;
    }
    case 'beyond_scheduled_tour': {
      starts = new Map<AssignmentView, OvertimeSpan[]>();
      for (const view of timeline) {
        if (!isWorked(view)) continue;
        if ((view.assignment.holdoverMinutes ?? 0) > threshold)
          starts.set(view, toEnd(view, scheduledMinutesOf(view, tz) + threshold));
      }
      break;
    }
    case 'consecutive': {
      starts = new Map<AssignmentView, OvertimeSpan[]>();
      for (const stretch of workedStretches(timeline)) {
        for (const view of stretch.views) {
          // Minutes already on the clock in the stretch, really worked: a holdover that overlaps
          // the next shift is not counted twice, and a clock change inside the stretch is.
          const before = realMinutesIn(
            { startMinute: stretch.window.startMinute, endMinute: view.window.startMinute },
            tz,
          );
          const from = Math.max(0, threshold - before);
          if (from < paidOf(view)) starts.set(view, toEnd(view, from));
        }
      }
      break;
    }
    default: {
      const unhandled: never = rule.basis;
      throw new Error(`Unpriced overtime basis: ${String(unhandled)}`);
    }
  }
  // Overtime too short to pay leaves the shift straight time under this rule alone; another rule
  // that reaches the same hours still pays them. A rule's own overtime ends at `minutesOf`: past
  // a non-pyramiding weekly rule's straight minutes, the minutes are another rule's.
  if (!withTail) for (const view of starts.keys()) if (!view.inPeriod) starts.delete(view);
  const minimum = rule.minimumMinutes ?? 0;
  if (minimum > 0)
    for (const [view, spans] of starts) {
      const countable = minutesOf(view);
      const own = spans.reduce((n, s) => n + Math.max(0, Math.min(s.to, countable) - s.from), 0);
      if (own < minimum) starts.delete(view);
    }
  return starts;
}

/**
 * The overtime bands of each in-period view once every active rule has had its say. Each rule
 * makes the end of a shift overtime from some hour on; an hour is overtime once, at the highest
 * multiplier of any rule that reaches it. So a 13-hour shift under California's daily rules is
 * 4 hours at 1.5× and 1 at 2×, not 5 at whichever single rule pays more. Bands run in the order
 * the hours are worked.
 */
function attributeOvertime(
  timeline: readonly AssignmentView[],
  ctx: CostContext,
  tz: readonly DstTransition[],
): Map<AssignmentView, OvertimeBand[]> {
  const paidOf = (view: AssignmentView) => paidMinutesOf(view, tz);
  // Per view, each rule's overtime spans (minutes into the shift) and their multiplier.
  const spansByView = new Map<AssignmentView, (OvertimeSpan & { multiplier: number })[]>();
  const nurseId = timeline[0]?.assignment.nurseId;
  const leave = nurseId === undefined ? undefined : ctx.overtimeLeave?.get(nurseId);
  const isSeventhDay = seventhDayTest(timeline, ctx.workWeekStartsOn);
  const active = activeRulesFor(timeline, ctx);
  // Per view, the minute its first non-window overtime starts: what a weekly or pay-period rule
  // that does not pyramid may count. So those bases are priced first.
  // An hour paid as daily-style overtime is credited toward a window rule's threshold, not
  // counted again (29 U.S.C. 207(h)(2); 29 CFR 778.202(c)), unless the rule says `'stack'`. With no
  // daily-style rule for this nurse there is nothing to credit, and every hour counts.
  const dailyStyleActive = active.some((rule) => !isWindowBasis(rule));
  const straight = new Map<AssignmentView, number>();
  const record = (rule: OvertimeRule, byView: Map<AssignmentView, OvertimeSpan[]>) => {
    for (const [view, spans] of byView) {
      if (!view.inPeriod) continue;
      const all = spansByView.get(view) ?? [];
      for (const span of spans) all.push({ ...span, multiplier: rule.multiplier });
      spansByView.set(view, all);
    }
  };
  for (const rule of active) {
    if (isWindowBasis(rule)) continue;
    // Lookback views too: their straight hours open the week a non-pyramiding rule counts.
    const spansByView = overtimeStarts(
      rule,
      timeline,
      ctx,
      leave,
      isSeventhDay,
      tz,
      undefined,
      true,
    );
    // A non-window basis gives one span, to the shift's end: its start is where straight time ends.
    for (const [view, spans] of spansByView)
      for (const { from } of spans)
        straight.set(view, Math.min(straight.get(view) ?? paidOf(view), from));
    record(rule, spansByView);
  }
  const straightOf = (view: AssignmentView) => straight.get(view) ?? paidOf(view);
  for (const rule of active) {
    if (!isWindowBasis(rule)) continue;
    const pyramiding = rule.pyramiding ?? (dailyStyleActive ? 'none' : 'stack');
    const countedOf = pyramiding === 'none' ? straightOf : paidOf;
    record(rule, overtimeStarts(rule, timeline, ctx, leave, isSeventhDay, tz, countedOf));
  }

  const out = new Map<AssignmentView, OvertimeBand[]>();
  for (const [view, spans] of spansByView) {
    const cuts = [...new Set([0, paidOf(view), ...spans.flatMap((s) => [s.from, s.to])])].sort(
      (a, b) => a - b,
    );
    const bands: OvertimeBand[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i]!;
      const minutes = cuts[i + 1]! - from;
      let multiplier = 1;
      for (const s of spans)
        if (s.from <= from && from < s.to && s.multiplier > multiplier) multiplier = s.multiplier;
      // Straight time is no band.
      if (multiplier === 1) continue;
      const last = bands[bands.length - 1];
      if (last && last.multiplier === multiplier && last.from + last.minutes === from)
        last.minutes += minutes;
      else bands.push({ from, minutes, multiplier });
    }
    out.set(view, bands);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pricing one shift
// ---------------------------------------------------------------------------

function differentialOf(ctx: CostContext, kind: DifferentialKind): Differential | undefined {
  return ctx.differentials.find((d) => d.kind === kind && d.active);
}

/**
 * Hours of `window` that fall inside the recurring daily window [startTime, endTime) (end <= start
 * wraps past midnight), on every day the shift touches. Both are half-open minutes on the
 * continuous timeline, so a shift ending at the window's start earns nothing. Each day's overlap
 * counts the real minutes worked in it (`transitions`, D19), so the fall-back night's repeated
 * hour is paid; with none, every hour is a wall hour.
 */
export function hoursInDailyWindow(
  window: ShiftWindow,
  daily: { startTime: string; endTime: string },
  transitions: readonly DstTransition[] = [],
): number {
  return minutesInDailyWindow(window, daily, transitions) / MINUTES_PER_HOUR;
}

/** `hoursInDailyWindow` in whole minutes, which is what pricing counts in. */
function minutesInDailyWindow(
  window: ShiftWindow,
  daily: { startTime: string; endTime: string },
  tz: readonly DstTransition[],
): number {
  const from = parseTimeOfDay(daily.startTime);
  const to = parseTimeOfDay(daily.endTime);
  const length = to > from ? to - from : MINUTES_PER_DAY - from + to;
  let minutes = 0;
  // One day back: a wrapping window that began the evening before the shift starts.
  for (
    let day = Math.floor(window.startMinute / MINUTES_PER_DAY) - 1;
    day * MINUTES_PER_DAY < window.endMinute;
    day++
  ) {
    const start = day * MINUTES_PER_DAY + from;
    const overlap: ShiftWindow = {
      startMinute: Math.max(window.startMinute, start),
      endMinute: Math.min(window.endMinute, start + length),
    };
    if (overlap.endMinute > overlap.startMinute) minutes += realMinutesIn(overlap, tz);
  }
  return minutes;
}

/**
 * The clock-windowed night/evening differentials a shift touches: those it earns on every hour
 * (`whole`) and those it earns only on the minutes inside the window (`partial`).
 */
function clockDifferentials(
  view: AssignmentView,
  ctx: CostContext,
  tz: readonly DstTransition[],
): { whole: Differential[]; partial: { d: Differential; minutes: number }[] } {
  const whole: Differential[] = [];
  const partial: { d: Differential; minutes: number }[] = [];
  for (const kind of ['night', 'evening'] as const) {
    const d = differentialOf(ctx, kind);
    if (!d?.window) continue;
    const inWindow = Math.min(
      minutesInDailyWindow(view.window, d.window, tz),
      paidMinutesOf(view, tz),
    );
    const threshold = d.window.wholeShiftAtHours;
    if (threshold !== null && inWindow >= Math.round(threshold * MINUTES_PER_HOUR)) whole.push(d);
    else if (inWindow > 0) partial.push({ d, minutes: inWindow });
  }
  return { whole, partial };
}

/**
 * The worked views that earn the `consecutive_shift` premium (UC–CNA Art. 14 § I.3). A run is
 * consecutive dates each holding a worked shift, lookback included; standby is not work and leave
 * leaves a date empty, so both are days off. A shift crosses the threshold when the run's full
 * shifts dated on its own day and the `withinDays` before it number more than `afterShifts`; from
 * then every shift of the run earns it until a day off, even if a short shift lets the window's
 * count fall back. The contract's text is about nurses on 12-hour shifts, so a shift is "full"
 * when scheduled for 12 hours or more — the declared length, never a holdover making one.
 */
function consecutiveShiftEarners(
  timeline: readonly AssignmentView[],
  ctx: CostContext,
): ReadonlySet<AssignmentView> {
  const earners = new Set<AssignmentView>();
  const trigger = differentialOf(ctx, 'consecutive_shift')?.consecutive;
  if (!trigger) return earners;
  let lastDate: IsoDate | undefined;
  let fullDates: IsoDate[] = [];
  let crossed = false;
  // The timeline is sorted by start, so dates only move forward.
  for (const view of timeline) {
    if (!isWorked(view)) continue;
    const date = view.assignment.date;
    if (lastDate !== undefined && date !== lastDate && date !== addDays(lastDate, 1)) {
      fullDates = [];
      crossed = false;
    }
    lastDate = date;
    if (view.scheduledHours >= 12) fullDates.push(date);
    const from = addDays(date, -trigger.withinDays);
    const inWindow = fullDates.filter((d) => compareDates(d, from) >= 0).length;
    if (inWindow > trigger.afterShifts) crossed = true;
    if (crossed) earners.add(view);
  }
  return earners;
}

/** Which differentials a *worked* shift earns on every hour, in itemisation order. */
function applicableDifferentials(
  view: AssignmentView,
  ctx: CostContext,
  consecutive: boolean,
  tz: readonly DstTransition[],
): Differential[] {
  // The whole-shift holiday premium goes to the date the unit's attribution gives the shift
  // (`schedule/holiday-attribution.ts`): by default its start day, same as the fairness ledger,
  // so the night into a holiday morning is not a holiday shift. Under `'clock'` the premium is
  // paid by the hour instead (`clockHolidayLines`), so no whole-shift one applies. A major holiday
  // earns the major premium in place of the holiday one, never both; a unit with no major premium
  // pays every holiday the holiday premium, as before.
  const attribution = ctx.unit.holidayAttribution ?? 'start';
  const [holiday] =
    attribution === 'clock'
      ? []
      : attributedHolidayDates(view.assignment.date, view.shiftType, attribution, (d) =>
          ctx.holidayDates.has(d),
        );
  const major = holiday !== undefined && isMajorHoliday(ctx, holiday);
  // A windowed night/evening differential is judged by the clock in `clockDifferentials`; the
  // flag only speaks for a night differential that has no window.
  const clock = clockDifferentials(view, ctx, tz);
  const nightFlag = differentialOf(ctx, 'night')?.window === undefined && view.shiftType.isNight;
  const applies: Record<DifferentialKind, boolean> = {
    night: nightFlag || clock.whole.some((d) => d.kind === 'night'),
    evening: clock.whole.some((d) => d.kind === 'evening'),
    weekend: isWeekendWindow(view.window, ctx.weekendDefinition),
    holiday: holiday !== undefined && !major,
    major_holiday: major,
    consecutive_shift: consecutive,
    charge: view.assignment.isCharge,
    agency: view.nurse.employmentType === 'agency',
    // Standby is priced separately; call-back is a day-of event with no assignment to hang on.
    on_call: false,
    call_back: false,
  };
  const out: Differential[] = [];
  for (const kind of DIFFERENTIAL_ORDER) {
    if (!applies[kind]) continue;
    const d = differentialOf(ctx, kind);
    if (d) out.push(d);
  }
  return out;
}

/** Whether a holiday date earns the major premium: it is major, and the unit pays one. */
function isMajorHoliday(ctx: CostContext, date: IsoDate): boolean {
  return (
    (ctx.majorHolidayDates?.has(date) ?? false) &&
    differentialOf(ctx, 'major_holiday') !== undefined
  );
}

/**
 * Under `'clock'` holiday attribution, the minutes of `window` on each holiday and the
 * differential they earn (major or ordinary, per date), with where those minutes lie in the
 * shift, `[from, to)` minutes from its start, for holiday pay's cover of overtime.
 */
function clockHolidayMinutes(
  view: AssignmentView,
  ctx: CostContext,
  window: ShiftWindow,
  tz: readonly DstTransition[],
): { d: Differential; minutes: number; from: number; to: number }[] {
  const out: { d: Differential; minutes: number; from: number; to: number }[] = [];
  const onHoliday = holidayMinutesOn(
    view.assignment.date,
    view.shiftType,
    window,
    'clock',
    (d) => ctx.holidayDates.has(d),
    tz,
  );
  for (const [date, minutes] of onHoliday) {
    const d = differentialOf(ctx, isMajorHoliday(ctx, date) ? 'major_holiday' : 'holiday');
    if (d === undefined || minutes <= 0) continue;
    const dayStart = dayNumber(date) * MINUTES_PER_DAY;
    const { startMinute: start, endMinute: end } = view.window;
    out.push({
      d,
      minutes,
      from: realOffset(start, end, dayStart, tz),
      to: realOffset(start, end, dayStart + MINUTES_PER_DAY, tz),
    });
  }
  return out;
}

/**
 * Whether the nurse is on the Baylor weekend plan (38 U.S.C. § 7456). The one test, shared with
 * the rules, both solvers, the fairness ledger, holiday priority and compliance alerts: what the
 * plan exempts (weekend caps, holiday rotation and entitlement, weekend burden) must not drift
 * between them, or Generate prices what the ledger never records.
 */
export function isBaylorPlan(nurse: Pick<Nurse, 'scheduleKind'>): boolean {
  return nurse.scheduleKind === 'va_baylor';
}

/**
 * Whether a shift is one of a Baylor nurse's regularly scheduled 12-hour weekend tours: started on
 * a Saturday or Sunday, or a Friday night running into Saturday (38 U.S.C. § 7456(a)). § 7456(d)
 * denies § 7453's night, weekend and holiday pay "for any period included in" such a tour, and
 * § 7456(b)(3)(B) says whose: "a nurse to whom this subsection is applicable is not entitled to
 * additional pay under section 7453 … for any period included in a regularly scheduled 12-hour
 * tour of duty". A tour picked up as overtime is not regularly scheduled, so it keeps them. The
 * one definition, shared with the rule that judges tour plans (which exempts overtime too).
 */
export function isBaylorTour(view: AssignmentView): boolean {
  if (!isBaylorPlan(view.nurse) || view.scheduledHours !== 12) return false;
  if (view.assignment.isOvertime) return false;
  return isBaylorWeekendDay(view);
}

/** Whether a shift is dated a Saturday or Sunday, or a Friday and runs into Saturday. */
function isBaylorWeekendDay(view: AssignmentView): boolean {
  const weekday = weekdayOf(view.assignment.date);
  return weekday === 6 || weekday === 0 || (weekday === 5 && crossesMidnight(view.shiftType));
}

/** The differentials 38 U.S.C. § 7453 pays, which § 7456(d) withholds from a Baylor tour. */
const SECTION_7453_KINDS: ReadonlySet<DifferentialKind> = new Set([
  'night',
  'evening',
  'weekend',
  'holiday',
  'major_holiday',
]);

/** Put a differential line in its itemisation place: after base, before later kinds. */
function insertInOrder(lines: CostLine[], line: CostLine): void {
  const order = DIFFERENTIAL_ORDER.indexOf(line.kind as DifferentialKind);
  const at = lines.findIndex(
    (l) => l.kind !== 'base' && DIFFERENTIAL_ORDER.indexOf(l.kind as DifferentialKind) > order,
  );
  lines.splice(at === -1 ? lines.length : at, 0, line);
}

/** A line of `hours` at `rate`, its amount rounded to the cent as payroll pays it. */
function line(kind: CostLineKind, hours: number, rate: number): CostLine {
  return { kind, hours, rate, amount: roundCents(hours * rate) };
}

/**
 * A shift priced at straight time: everything but overtime. `regular` is what it adds to the
 * regular rate of its window (29 CFR 778.109, 778.115): its straight dollars and the minutes
 * worked, absent for standby (not hours worked) and an unpriced shift (no rate on file).
 */
interface StraightPay {
  cost: AssignmentCost;
  regular?: { dollars: number; minutes: number };
  /** The minutes into the shift, `[from, to)`, whose overtime holiday pay covers (§ 7453(g)). */
  covered: readonly OvertimeSpan[];
}

function priceStraight(
  view: AssignmentView,
  ctx: CostContext,
  consecutive: boolean,
  tz: readonly DstTransition[],
): StraightPay {
  const paidMinutes = paidMinutesOf(view, tz);
  const hours = paidMinutes / MINUTES_PER_HOUR;
  const identity = {
    assignmentId: view.assignment.id,
    nurseId: view.assignment.nurseId,
    shiftTypeId: view.assignment.shiftTypeId,
    date: view.assignment.date,
    hours,
  };

  const resolved = resolvePayRate(ctx.payRates, view.nurse, view.assignment.date);
  if (!resolved) {
    return {
      cost: {
        ...identity,
        baseRate: 0,
        rateSource: 'none',
        straightRate: 0,
        overtimeHours: 0,
        lines: [],
        total: 0,
      },
      covered: [],
    };
  }
  const base = resolved.rate.hourlyRate;

  if (view.shiftType.isOnCall) {
    // Standby earns the on-call differential alone. A unit with no on-call differential
    // configured prices standby at $0 — visibly, as a zero line, not by vanishing.
    const d = differentialOf(ctx, 'on_call');
    const rate = d === undefined ? 0 : d.mode === 'flat' ? d.amount : base * d.amount;
    const standby = line('on_call', hours, rate);
    return {
      cost: {
        ...identity,
        baseRate: base,
        rateSource: resolved.source,
        straightRate: rate,
        overtimeHours: 0,
        lines: [standby],
        total: standby.amount,
      },
      covered: [],
    };
  }

  const lines: CostLine[] = [line('base', hours, base)];
  let running = base;
  const baylorTour = isBaylorTour(view);
  const earned = applicableDifferentials(view, ctx, consecutive, tz);
  // A Baylor tour's scheduled hours earn only the hospital's own premiums (§ 7456(d)). The
  // consecutive-shift premium is a contract's, not § 7453's, so it is not withheld here.
  const applicable = baylorTour ? earned.filter((d) => !SECTION_7453_KINDS.has(d.kind)) : earned;
  for (const d of applicable) {
    if (d.mode !== 'flat') continue;
    lines.push(line(d.kind, hours, d.amount));
    running += d.amount;
  }
  // Additive stacking (UC–CNA Art. 14 §N, Title 38) takes every multiplier on the base rate alone;
  // compound is the FLSA regular rate, each on the running rate.
  const additive = ctx.premiumStacking === 'additive';
  for (const d of applicable) {
    if (d.mode !== 'multiplier') continue;
    // Itemised as the increment this multiplier adds to the running rate, so the lines sum
    // to the total and a 1.0× multiplier shows as a $0 line rather than disappearing.
    const increment = (additive ? base : running) * (d.amount - 1);
    lines.push(line(d.kind, hours, increment));
    running = additive ? running + increment : running * d.amount;
  }
  // Partial clock differentials are paid on the base rate and kept out of `running`, the shift's
  // own straight rate. Under compound stacking their dollars are still straight pay, so they are
  // in the week's regular rate (29 CFR 778.207(b)); under additive (38 U.S.C. § 7453: night pay
  // and overtime are both percentages of basic pay) they stay out of the overtime rate.
  const partial = clockDifferentials(view, ctx, tz).partial;
  const onBase = (d: Differential, minutes: number) => {
    const rate = d.mode === 'flat' ? d.amount : base * (d.amount - 1);
    insertInOrder(lines, line(d.kind, minutes / MINUTES_PER_HOUR, rate));
  };
  if (!baylorTour) for (const { d, minutes: inWindow } of partial) onBase(d, inWindow);
  else {
    // A holdover is outside the tour, so § 7453 pays it again: on base, out of `running`, like a
    // partial clock differential.
    const held = paidMinutes - scheduledMinutesOf(view, tz);
    if (held > 0) {
      for (const d of earned) if (SECTION_7453_KINDS.has(d.kind)) onBase(d, held);
      const holdover: ShiftWindow = {
        startMinute: shiftWindow(view.assignment.date, view.shiftType).endMinute,
        endMinute: view.window.endMinute,
      };
      for (const { d } of partial) {
        const inWindow = minutesInDailyWindow(holdover, d.window!, tz);
        if (inWindow > 0) onBase(d, inWindow);
      }
    }
  }
  // Holiday premium by the clock (`holidayAttribution: 'clock'`): a line on each holiday's minutes,
  // like a partial clock differential, out of `running`. Under compound it is a multiplier on the
  // shift's straight rate so far, under additive on base; a Baylor tour earns it only on held
  // hours, on base (§ 7456(d)).
  const scheduledMinutes = scheduledMinutesOf(view, tz);
  const byClock = (ctx.unit.holidayAttribution ?? 'start') === 'clock';
  const holidayWindow: ShiftWindow = baylorTour
    ? {
        startMinute: shiftWindow(view.assignment.date, view.shiftType).endMinute,
        endMinute: view.window.endMinute,
      }
    : view.window;
  const clockHolidays = byClock ? clockHolidayMinutes(view, ctx, holidayWindow, tz) : [];
  for (const { d, minutes } of clockHolidays) {
    const onRate = additive || baylorTour ? base : running;
    const rate = d.mode === 'flat' ? d.amount : onRate * (d.amount - 1);
    insertInOrder(lines, line(d.kind, minutes / MINUTES_PER_HOUR, rate));
  }

  // 38 U.S.C. § 7453(g): "no overtime pay … shall be payable for overtime service performed on a
  // holiday … in addition to pay received under subsection (d) for such service". So coverage
  // follows the minutes actually paid under (d): every minute of a shift with a whole-shift holiday
  // line, or by the clock only the minutes on the holiday; on a Baylor tour only the held minutes
  // (§ 7456(d) pays the tour itself none), whose earlier overtime keeps its premium. Covered
  // minutes still count, so the alert and the ledger see them.
  const covers = ctx.holidayPayCoversOvertime === true;
  const from = baylorTour ? scheduledMinutes : 0;
  const covered: OvertimeSpan[] = !covers
    ? []
    : byClock
      ? clockHolidays
          .map((h) => ({ from: Math.max(h.from, from), to: h.to }))
          .filter((h) => h.to > h.from)
      : earned.some((d) => d.kind === 'holiday' || d.kind === 'major_holiday')
        ? [{ from, to: Number.POSITIVE_INFINITY }]
        : [];
  const total = sumCents(lines.map((l) => l.amount));
  return {
    cost: {
      ...identity,
      baseRate: base,
      rateSource: resolved.source,
      straightRate: running,
      overtimeHours: 0,
      lines,
      total,
    },
    regular: { dollars: total, minutes: paidMinutes },
    covered,
  };
}

/**
 * The rate each minute of a shift's overtime is paid half (or more) of again: the regular rate
 * of the window that minute was worked in. `edge` is the minute into the shift where the next
 * window begins (infinite when the shift does not cross one).
 */
interface OvertimeRates {
  edge: number;
  before: number;
  after: number;
}

/** The parts of `[from, to)` outside every covered span, in order. */
function uncovered(from: number, to: number, covered: readonly OvertimeSpan[]): OvertimeSpan[] {
  let open: OvertimeSpan[] = [{ from, to }];
  for (const c of covered) {
    open = open.flatMap((o) =>
      [
        { from: o.from, to: Math.min(o.to, c.from) },
        { from: Math.max(o.from, c.to), to: o.to },
      ].filter((p) => p.to > p.from),
    );
  }
  return open;
}

/** A straight-priced shift with its overtime bands added, each piece on its window's rate. */
function addOvertime(
  straight: StraightPay,
  bands: readonly OvertimeBand[] | undefined,
  rates: OvertimeRates | undefined,
): AssignmentCost {
  // A band of zero minutes is no band: an exactly-40-hour week writes no overtime line.
  const live = (bands ?? []).filter((b) => b.minutes > 0);
  const overtimeMinutes = live.reduce((n, b) => n + b.minutes, 0);
  // Attribution is a fact about the hours, not the money: the publish alert needs it for a nurse
  // whose rate has not been entered yet, and standby never has any.
  const cost = { ...straight.cost, overtimeHours: overtimeMinutes / MINUTES_PER_HOUR };
  if (rates === undefined || live.length === 0) return cost;
  const lines = [...cost.lines];
  for (const band of live) {
    // Only the band's minutes holiday pay does not cover earn the premium; a piece either side of
    // the window edge is paid on its own window's rate.
    for (const open of uncovered(band.from, band.from + band.minutes, straight.covered)) {
      const pieces = [
        { from: open.from, to: Math.min(open.to, rates.edge), rate: rates.before },
        { from: Math.max(open.from, rates.edge), to: open.to, rate: rates.after },
      ];
      for (const piece of pieces) {
        if (piece.to <= piece.from) continue;
        lines.push(
          line(
            'overtime',
            (piece.to - piece.from) / MINUTES_PER_HOUR,
            piece.rate * (band.multiplier - 1),
          ),
        );
      }
    }
  }
  return { ...cost, lines, total: sumCents(lines.map((l) => l.amount)) };
}

/**
 * A window's regular rate, dollars an hour (29 CFR 778.115): its straight dollars over its hours
 * worked. Only asked of a window holding overtime, which always holds the minutes of the shift
 * carrying it; an empty one means attribution and the rate disagree, and a $0 premium would hide
 * that, so it throws.
 */
export function regularRateFrom(sum: { dollars: number; minutes: number } | undefined): number {
  if (sum === undefined || sum.minutes <= 0) {
    throw new Error(
      'Overtime fell in a pay window with no hours worked, so it has no regular rate',
    );
  }
  return (sum.dollars / sum.minutes) * MINUTES_PER_HOUR;
}

/** Every in-period assignment of one nurse, priced with overtime attributed across their week. */
function costTimeline(timeline: readonly AssignmentView[], ctx: CostContext): AssignmentCost[] {
  // The host's clock changes: every hour pay counts is a real one (D19). Classification (a tour, a
  // full 12, a Baylor tour) still reads declared hours.
  const tz = ctx.dstTransitions ?? [];
  const overtime = attributeOvertime(timeline, ctx, tz);
  const consecutive = consecutiveShiftEarners(timeline, ctx);
  const additive = ctx.premiumStacking === 'additive';
  // Every in-period shift, and the lookback tail too when it can feed a regular rate.
  const needsTail = !additive && [...overtime.values()].some((bands) => bands.length > 0);
  const straight = new Map<AssignmentView, StraightPay>();
  for (const view of timeline)
    if (view.inPeriod || needsTail)
      straight.set(view, priceStraight(view, ctx, consecutive.has(view), tz));

  // The premium's rate: under additive stacking the base (UC–CNA Art. 14 §N, Title 38); under
  // compound the regular rate of the work week, or of the pay period for a nurse on an 8/80 rule
  // (29 CFR 778.601(e)), so it does not depend on which shift carries the band (D16).
  const active = activeRulesFor(timeline, ctx);
  const week = workWeekFor(timeline[0]?.nurse, ctx);
  const calendar =
    active.some((r) => r.basis === 'pay_period') && !active.some((r) => r.basis === 'weekly')
      ? payPeriodCalendar(ctx)
      : weekCalendar(week.startsOn);
  const byClock = (ctx.overtimeWindowAttribution ?? 'clock') === 'clock';
  const startMinute = week.startMinute;
  // The window-day a view starts on, which names its window (its date at a midnight start).
  const dayOf = (view: AssignmentView) => windowDayOf(view.window.startMinute, startMinute);
  // Minutes of a view in its own window; the rest are the next window's (T06's split point).
  const firstPart = (view: AssignmentView, paid: number) =>
    byClock
      ? Math.min(paid, minutesBeforeEdge(view, calendar.nextStart(dayOf(view)), tz, startMinute))
      : paid;
  const sums = new Map<IsoDate, { dollars: number; minutes: number }>();
  const add = (window: IsoDate, dollars: number, minutes: number) => {
    const sum = sums.get(window) ?? { dollars: 0, minutes: 0 };
    sum.dollars += dollars;
    sum.minutes += minutes;
    sums.set(window, sum);
  };
  if (!additive)
    for (const [view, pay] of straight) {
      if (!pay.regular) continue;
      const { dollars, minutes } = pay.regular;
      const first = firstPart(view, minutes);
      add(calendar.windowOf(dayOf(view)), (dollars * first) / minutes, first);
      if (first < minutes)
        add(
          calendar.windowOf(calendar.nextStart(dayOf(view))),
          (dollars * (minutes - first)) / minutes,
          minutes - first,
        );
    }
  const regularRate = (window: IsoDate) => regularRateFrom(sums.get(window));
  const ratesFor = (view: AssignmentView, pay: StraightPay): OvertimeRates | undefined => {
    if (!pay.regular) return undefined;
    if (additive) {
      const base = pay.cost.baseRate;
      return { edge: Number.POSITIVE_INFINITY, before: base, after: base };
    }
    const date = dayOf(view);
    const first = firstPart(view, pay.regular.minutes);
    const before = regularRate(calendar.windowOf(date));
    // The next window's rate only for a shift that runs into it.
    if (first >= pay.regular.minutes)
      return { edge: Number.POSITIVE_INFINITY, before, after: before };
    return { edge: first, before, after: regularRate(calendar.windowOf(calendar.nextStart(date))) };
  };

  const out: AssignmentCost[] = [];
  for (const view of timeline) {
    if (!view.inPeriod) continue;
    const pay = straight.get(view)!;
    out.push(addOvertime(pay, overtime.get(view), ratesFor(view, pay)));
  }
  return out;
}

/** One nurse's in-period assignments, priced. Chronological. */
export function costNurse(schedule: ScheduleView, ctx: CostContext, nurseId: Id): AssignmentCost[] {
  return costTimeline(schedule.timelineFor(nurseId), ctx);
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

const LINE_KINDS: readonly CostLineKind[] = ['base', ...DIFFERENTIAL_ORDER, 'overtime'];

/**
 * `CostTotals` while they add up: hours in whole minutes and dollars in whole cents, so a unit
 * total is exactly the sum of its shift totals, which are exactly the sums of their lines. Float
 * sums drift by fractions of a cent and stop matching payroll's cent-rounded lines.
 */
interface Tally {
  minutes: number;
  overtimeMinutes: number;
  base: number;
  differentials: number;
  overtimePremium: number;
  total: number;
  byKind: Record<CostLineKind, number>;
}

const toMinutes = (hours: number) => Math.round(hours * MINUTES_PER_HOUR);
const toCents = (dollars: number) => Math.round(dollars * 100);

function emptyTally(): Tally {
  const byKind = {} as Record<CostLineKind, number>;
  for (const kind of LINE_KINDS) byKind[kind] = 0;
  return {
    minutes: 0,
    overtimeMinutes: 0,
    base: 0,
    differentials: 0,
    overtimePremium: 0,
    total: 0,
    byKind,
  };
}

function accumulate(into: Tally, cost: AssignmentCost): void {
  // Exact only because `priceStraight` and `addOvertime` already made `hours` whole minutes and
  // `total` and each `amount` whole cents; the conversions below recover those integers, they
  // round nothing.
  into.minutes += toMinutes(cost.hours);
  into.overtimeMinutes += toMinutes(cost.overtimeHours);
  into.total += toCents(cost.total);
  for (const line of cost.lines) {
    const cents = toCents(line.amount);
    into.byKind[line.kind] += cents;
    if (line.kind === 'base') into.base += cents;
    else if (line.kind === 'overtime') into.overtimePremium += cents;
    else into.differentials += cents;
  }
}

function totalsOf(tally: Tally): CostTotals {
  const byKind = {} as Record<CostLineKind, number>;
  for (const kind of LINE_KINDS) byKind[kind] = tally.byKind[kind] / 100;
  return {
    hours: tally.minutes / MINUTES_PER_HOUR,
    overtimeHours: tally.overtimeMinutes / MINUTES_PER_HOUR,
    base: tally.base / 100,
    differentials: tally.differentials / 100,
    overtimePremium: tally.overtimePremium / 100,
    total: tally.total / 100,
    byKind,
  };
}

function concentration(nurses: readonly NurseCost[]): OvertimeConcentration {
  const totalHours =
    nurses.reduce((acc, n) => acc + toMinutes(n.overtimeHours), 0) / MINUTES_PER_HOUR;
  const totalPremium = sumCents(nurses.map((n) => n.overtimePremium));
  const ranked: NurseOvertime[] = nurses
    .filter((n) => n.overtimeHours > 0)
    .map((n) => ({
      nurseId: n.nurseId,
      hours: n.overtimeHours,
      premium: n.overtimePremium,
      share: totalHours === 0 ? 0 : n.overtimeHours / totalHours,
    }))
    .sort((a, b) => b.hours - a.hours || (a.nurseId < b.nurseId ? -1 : 1));
  return {
    totalHours,
    totalPremium,
    ranked,
    nursesWithOvertime: ranked.length,
    topThreeShare: ranked.slice(0, 3).reduce((acc, r) => acc + r.share, 0),
    gini: gini(nurses.map((n) => n.overtimeHours)),
  };
}

/** Price a whole period. Only in-period assignments are costed; the lookback tail is context. */
export function costSchedule(schedule: ScheduleView, ctx: CostContext): ScheduleCost {
  const assignments: AssignmentCost[] = [];
  const nurses: NurseCost[] = [];
  const totals = emptyTally();
  const unpricedNurseIds: Id[] = [];

  for (const nurseId of schedule.nursesById.keys()) {
    const costs = costNurse(schedule, ctx, nurseId);
    if (costs.length === 0) continue;
    const tally = emptyTally();
    let unpricedAssignments = 0;
    for (const cost of costs) {
      if (cost.rateSource === 'none') unpricedAssignments++;
      accumulate(tally, cost);
      accumulate(totals, cost);
      assignments.push(cost);
    }
    if (unpricedAssignments > 0) unpricedNurseIds.push(nurseId);
    nurses.push({ ...totalsOf(tally), nurseId, assignments: costs.length, unpricedAssignments });
  }

  nurses.sort((a, b) => b.total - a.total || (a.nurseId < b.nurseId ? -1 : 1));
  unpricedNurseIds.sort();
  // Per-nurse costing walks each timeline in turn; restore schedule order for the flat list.
  const order = new Map(schedule.assignments().map((v, i) => [v.assignment.id, i]));
  assignments.sort((a, b) => (order.get(a.assignmentId) ?? 0) - (order.get(b.assignmentId) ?? 0));

  return {
    periodId: schedule.period.id,
    assignments,
    nurses,
    totals: totalsOf(totals),
    unpricedAssignments: nurses.reduce((acc, n) => acc + n.unpricedAssignments, 0),
    unpricedNurseIds,
    overtime: concentration(nurses),
  };
}

// ---------------------------------------------------------------------------
// Candidate pricing
// ---------------------------------------------------------------------------

/**
 * What adding `candidate` would cost. The nurse is re-costed with and without it on a view
 * containing only their own timeline, so the price of one candidate does not scale with the
 * size of the unit. The candidate must carry an id that is not already on the schedule.
 */
export function marginalCost(
  schedule: ScheduleView,
  ctx: CostContext,
  candidate: Assignment,
): MarginalCost {
  const nurse = schedule.nursesById.get(candidate.nurseId);
  if (!nurse) throw new Error(`Candidate references unknown nurse ${candidate.nurseId}`);
  const timeline = schedule.timelineFor(candidate.nurseId);
  const before = sumCents(costTimeline(timeline, ctx).map((c) => c.total));

  const withCandidate = new ScheduleView({
    period: schedule.period,
    assignments: [...timeline.filter((v) => v.inPeriod).map((v) => v.assignment), candidate],
    priorAssignments: timeline.filter((v) => !v.inPeriod).map((v) => v.assignment),
    nurses: [nurse],
    shiftTypes: [...schedule.shiftTypesById.values()],
  });
  const after = costTimeline(withCandidate.timelineFor(candidate.nurseId), ctx);
  const cost = after.find((c) => c.assignmentId === candidate.id);
  if (!cost) throw new Error(`Candidate ${candidate.id} was not priced`);
  const afterTotal = sumCents(after.map((c) => c.total));

  return { candidate, cost, delta: roundCents(afterTotal - before) };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export function compareToBudget(actualDollars: number, targetDollars: number): BudgetVariance {
  return {
    targetDollars,
    actualDollars,
    variance: roundCents(actualDollars - targetDollars),
    ratio: targetDollars === 0 ? null : actualDollars / targetDollars,
  };
}
