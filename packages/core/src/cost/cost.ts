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
  crossesMidnight,
  type IsoDate,
  isWeekendWindow,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  parseTimeOfDay,
  type ShiftWindow,
  weekdayOf,
} from '../domain/time.js';
import { gini } from '../fairness/distribution.js';
import { payPeriodIndex, payPeriodWindow } from '../rules/hours-rules.js';
import type { PaidLeaveCredit } from '../rules/paid-leave.js';
import { isWorked } from '../rules/types.js';
import { holdoverHours, workedStretches } from '../schedule/holdover.js';
import { type AssignmentView, ScheduleView } from '../schedule/view.js';
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

/** A run of a shift's hours paid at one overtime multiplier. */
interface OvertimeBand {
  hours: number;
  multiplier: number;
}

/** The date a work week containing `date` starts on. */
function workWeekStart(date: IsoDate, startsOn: number): IsoDate {
  return addDays(date, -((weekdayOf(date) - startsOn + 7) % 7));
}

/**
 * Overtime hours per worked view under one rule. `windowOf` names the window a shift's hours
 * accrue in, by a date: the shift's own start date for a workday, or the first date of its week
 * or pay period. Hours accrue in chronological order, since the timeline is sorted by shift
 * start. So earlier hours use up the threshold first, only the shifts that cross it carry
 * overtime, and only the hours past it: always the *end* of the shift. Tail views accrue and are
 * reported like any other; `overtimeStarts` decides whether its caller sees them. `counts` leaves
 * a view out of the accrual altogether (the seventh-day rule). `hoursOf` is what a view adds to
 * the accrual: its straight hours alone, for a weekly rule that does not pyramid.
 */
function windowOvertime(
  timeline: readonly AssignmentView[],
  threshold: number,
  windowOf: (date: IsoDate) => IsoDate,
  leave: readonly PaidLeaveCredit[] | undefined,
  counts: (view: AssignmentView) => boolean = () => true,
  hoursOf: (view: AssignmentView) => number = (view) => view.paidHours,
): Map<AssignmentView, number> {
  // Counted leave uses up the threshold first: a window's PTO day is not attributable to one
  // shift, and putting it first is what makes the shifts that cross the threshold the overtime
  // ones.
  const leaveByWindow = new Map<IsoDate, number>();
  for (const c of leave ?? []) {
    const window = windowOf(c.date);
    leaveByWindow.set(window, (leaveByWindow.get(window) ?? 0) + c.hours);
  }
  const out = new Map<AssignmentView, number>();
  const runningByWindow = new Map<IsoDate, number>();
  for (const view of timeline) {
    if (!isWorked(view) || !counts(view)) continue;
    const window = windowOf(view.assignment.date);
    const before = runningByWindow.get(window) ?? leaveByWindow.get(window) ?? 0;
    const after = before + hoursOf(view);
    runningByWindow.set(window, after);
    const over = after - Math.max(threshold, before);
    if (over > 0) out.set(view, over);
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
 * which the nurse has a worked shift scheduled for 12 hours, lookback included. The declared
 * length decides, never the worked one: an 8 held over four hours is not a tour (§ 7456A(c)(1)).
 */
function tourDayTest(
  timeline: readonly AssignmentView[],
  mode: 'only' | 'except',
): (view: AssignmentView) => boolean {
  const tourDates = new Set<IsoDate>();
  for (const view of timeline)
    if (isWorked(view) && view.scheduledHours === 12) tourDates.add(view.assignment.date);
  return (view) => tourDates.has(view.assignment.date) === (mode === 'only');
}

/** Whether a rule accrues over a week or pay period, and so can be told not to pyramid. */
function isWindowBasis(rule: OvertimeRule): boolean {
  return rule.basis === 'weekly' || rule.basis === 'pay_period';
}

/**
 * Where one rule makes each in-period view's overtime start, in hours into the shift. Every basis
 * is spelled out, so an unhandled one fails to compile here rather than falling through to the
 * weekly window.
 *
 * `straightOf` gives a view's hours before any other basis's overtime starts. A weekly or
 * pay-period rule with `pyramiding: 'none'` accrues only those, and puts its overtime on the last
 * of them, just before the daily premium hours. With `withTail`, lookback views get a start too.
 * Those only ever feed `straightOf`: a previous period's shift is not this schedule's cost, but its
 * daily premium hours are still not weekly hours.
 */
function overtimeStarts(
  rule: OvertimeRule,
  timeline: readonly AssignmentView[],
  ctx: CostContext,
  leave: readonly PaidLeaveCredit[] | undefined,
  isSeventhDay: (view: AssignmentView) => boolean,
  straightOf: (view: AssignmentView) => number = (view) => view.paidHours,
  withTail = false,
): Map<AssignmentView, number> {
  const hoursOf =
    isWindowBasis(rule) && rule.pyramiding === 'none'
      ? straightOf
      : (view: AssignmentView) => view.paidHours;
  const fromWindow = (hours: Map<AssignmentView, number>) =>
    new Map([...hours].map(([view, over]) => [view, hoursOf(view) - over]));
  let starts: Map<AssignmentView, number>;
  switch (rule.basis) {
    case 'daily':
      starts = fromWindow(
        windowOvertime(
          timeline,
          rule.thresholdHours,
          (d) => d,
          undefined,
          rule.tourDays === undefined ? undefined : tourDayTest(timeline, rule.tourDays),
        ),
      );
      break;
    case 'seventh_day':
      starts = fromWindow(
        windowOvertime(timeline, rule.thresholdHours, (d) => d, undefined, isSeventhDay),
      );
      break;
    case 'beyond_scheduled_days':
      starts = fromWindow(
        windowOvertime(
          timeline,
          rule.thresholdHours,
          (d) => d,
          undefined,
          extraDayTest(timeline, ctx.workWeekStartsOn),
        ),
      );
      break;
    case 'weekly':
      starts = fromWindow(
        windowOvertime(
          timeline,
          rule.thresholdHours,
          (d) => workWeekStart(d, ctx.workWeekStartsOn),
          leave,
          undefined,
          hoursOf,
        ),
      );
      break;
    case 'pay_period':
      starts = fromWindow(
        windowOvertime(
          timeline,
          rule.thresholdHours,
          (d) => payPeriodWindow(payPeriodIndex(d, ctx.unit), ctx.unit).start,
          leave,
          undefined,
          hoursOf,
        ),
      );
      break;
    case 'beyond_scheduled_tour': {
      starts = new Map<AssignmentView, number>();
      for (const view of timeline) {
        if (!isWorked(view)) continue;
        if (holdoverHours(view.assignment) > rule.thresholdHours)
          starts.set(view, view.scheduledHours + rule.thresholdHours);
      }
      break;
    }
    case 'consecutive': {
      starts = new Map<AssignmentView, number>();
      for (const stretch of workedStretches(timeline)) {
        for (const view of stretch.views) {
          // Hours already on the clock in the stretch, by the wall clock: a holdover that
          // overlaps the next shift is not counted twice.
          const before = (view.window.startMinute - stretch.window.startMinute) / MINUTES_PER_HOUR;
          const from = Math.max(0, rule.thresholdHours - before);
          if (from < view.paidHours) starts.set(view, from);
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
  // that reaches the same hours still pays them. A rule's own overtime ends at `hoursOf`: past a
  // non-pyramiding weekly rule's straight hours, the hours are another rule's.
  if (!withTail) for (const view of starts.keys()) if (!view.inPeriod) starts.delete(view);
  const minimumHours = (rule.minimumMinutes ?? 0) / MINUTES_PER_HOUR;
  if (minimumHours > 0)
    for (const [view, from] of starts) if (hoursOf(view) - from < minimumHours) starts.delete(view);
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
): Map<AssignmentView, OvertimeBand[]> {
  // Per view, where each rule's overtime starts (hours into the shift) and at what multiplier.
  const startsByView = new Map<AssignmentView, { from: number; multiplier: number }[]>();
  const nurseId = timeline[0]?.assignment.nurseId;
  const leave = nurseId === undefined ? undefined : ctx.overtimeLeave?.get(nurseId);
  const isSeventhDay = seventhDayTest(timeline, ctx.workWeekStartsOn);
  // A unit's rules for its 72/80 and Baylor nurses sit beside its standard ones (38 U.S.C.
  // §§ 7456, 7456A); each nurse is priced only by the rules for their kind.
  const kind = timeline[0]?.nurse.scheduleKind ?? 'standard';
  const active = ctx.overtimeRules.filter(
    (rule) =>
      rule.multiplier > 1 &&
      (rule.scheduleKinds === undefined || rule.scheduleKinds.includes(kind)),
  );
  // Per view, the hour its first non-window overtime starts: what a weekly or pay-period rule
  // that does not pyramid may count. So those bases are priced first.
  const straight = new Map<AssignmentView, number>();
  const record = (rule: OvertimeRule, fromByView: Map<AssignmentView, number>) => {
    for (const [view, from] of fromByView) {
      if (!view.inPeriod) continue;
      const starts = startsByView.get(view) ?? [];
      starts.push({ from, multiplier: rule.multiplier });
      startsByView.set(view, starts);
    }
  };
  for (const rule of active) {
    if (isWindowBasis(rule)) continue;
    // Lookback views too: their straight hours open the week a non-pyramiding rule counts.
    const fromByView = overtimeStarts(rule, timeline, ctx, leave, isSeventhDay, undefined, true);
    for (const [view, from] of fromByView)
      straight.set(view, Math.min(straight.get(view) ?? view.paidHours, from));
    record(rule, fromByView);
  }
  const straightOf = (view: AssignmentView) => straight.get(view) ?? view.paidHours;
  for (const rule of active) {
    if (!isWindowBasis(rule)) continue;
    record(rule, overtimeStarts(rule, timeline, ctx, leave, isSeventhDay, straightOf));
  }

  const out = new Map<AssignmentView, OvertimeBand[]>();
  for (const [view, starts] of startsByView) {
    const cuts = [...new Set([...starts.map((s) => s.from), view.paidHours])].sort((a, b) => a - b);
    const bands: OvertimeBand[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i]!;
      const hours = cuts[i + 1]! - from;
      let multiplier = 1;
      for (const s of starts)
        if (s.from <= from && s.multiplier > multiplier) multiplier = s.multiplier;
      const last = bands[bands.length - 1];
      if (last && last.multiplier === multiplier) last.hours += hours;
      else bands.push({ hours, multiplier });
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
 * continuous timeline, so a shift ending at the window's start earns nothing and DST cannot
 * move an hour in or out.
 */
export function hoursInDailyWindow(
  window: ShiftWindow,
  daily: { startTime: string; endTime: string },
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
    const overlap =
      Math.min(window.endMinute, start + length) - Math.max(window.startMinute, start);
    if (overlap > 0) minutes += overlap;
  }
  return minutes / MINUTES_PER_HOUR;
}

/**
 * The clock-windowed night/evening differentials a shift touches: those it earns on every hour
 * (`whole`) and those it earns only on the hours inside the window (`partial`).
 */
function clockDifferentials(
  view: AssignmentView,
  ctx: CostContext,
): { whole: Differential[]; partial: { d: Differential; hours: number }[] } {
  const whole: Differential[] = [];
  const partial: { d: Differential; hours: number }[] = [];
  for (const kind of ['night', 'evening'] as const) {
    const d = differentialOf(ctx, kind);
    if (!d?.window) continue;
    const inWindow = Math.min(hoursInDailyWindow(view.window, d.window), view.paidHours);
    const threshold = d.window.wholeShiftAtHours;
    if (threshold !== null && inWindow >= threshold) whole.push(d);
    else if (inWindow > 0) partial.push({ d, hours: inWindow });
  }
  return { whole, partial };
}

/** Which differentials a *worked* shift earns on every hour, in itemisation order. */
function applicableDifferentials(view: AssignmentView, ctx: CostContext): Differential[] {
  // Dated by start day, same as the fairness ledger: the night into a holiday morning is not a
  // holiday shift. A major holiday earns the major premium in place of the holiday one, never
  // both; a unit with no major premium pays every holiday the holiday premium, as before.
  const date = view.assignment.date;
  const major =
    (ctx.majorHolidayDates?.has(date) ?? false) &&
    differentialOf(ctx, 'major_holiday') !== undefined;
  // A windowed night/evening differential is judged by the clock in `clockDifferentials`; the
  // flag only speaks for a night differential that has no window.
  const clock = clockDifferentials(view, ctx);
  const nightFlag = differentialOf(ctx, 'night')?.window === undefined && view.shiftType.isNight;
  const applies: Record<DifferentialKind, boolean> = {
    night: nightFlag || clock.whole.some((d) => d.kind === 'night'),
    evening: clock.whole.some((d) => d.kind === 'evening'),
    weekend: isWeekendWindow(view.window, ctx.weekendDefinition),
    holiday: ctx.holidayDates.has(date) && !major,
    major_holiday: major,
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
 * denies § 7453's night, weekend and holiday pay "for any period included in" such a tour. The one
 * definition, shared with the rule that judges tour plans.
 */
export function isBaylorTour(view: AssignmentView): boolean {
  if (!isBaylorPlan(view.nurse) || view.scheduledHours !== 12) return false;
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

function sum(lines: readonly CostLine[]): number {
  let total = 0;
  for (const line of lines) total += line.amount;
  return total;
}

function priceView(
  view: AssignmentView,
  ctx: CostContext,
  overtime: readonly OvertimeBand[] | undefined,
): AssignmentCost {
  const hours = view.paidHours;
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
      ...identity,
      baseRate: 0,
      rateSource: 'none',
      straightRate: 0,
      // Attribution is a fact about the hours, not the money: the publish alert needs it for a
      // nurse whose rate has not been entered yet.
      overtimeHours: (overtime ?? []).reduce(
        (n, b) => (b.hours > 0 && b.multiplier > 1 ? n + b.hours : n),
        0,
      ),
      lines: [],
      total: 0,
    };
  }
  const base = resolved.rate.hourlyRate;

  if (view.shiftType.isOnCall) {
    // Standby earns the on-call differential alone. A unit with no on-call differential
    // configured prices standby at $0 — visibly, as a zero line, not by vanishing.
    const d = differentialOf(ctx, 'on_call');
    const rate = d === undefined ? 0 : d.mode === 'flat' ? d.amount : base * d.amount;
    const line: CostLine = { kind: 'on_call', hours, rate, amount: hours * rate };
    return {
      ...identity,
      baseRate: base,
      rateSource: resolved.source,
      straightRate: rate,
      overtimeHours: 0,
      lines: [line],
      total: line.amount,
    };
  }

  const lines: CostLine[] = [{ kind: 'base', hours, rate: base, amount: hours * base }];
  let running = base;
  const baylorTour = isBaylorTour(view);
  const earned = applicableDifferentials(view, ctx);
  // A Baylor tour's scheduled hours earn only the hospital's own premiums (§ 7456(d)).
  const applicable = baylorTour ? earned.filter((d) => !SECTION_7453_KINDS.has(d.kind)) : earned;
  for (const d of applicable) {
    if (d.mode !== 'flat') continue;
    lines.push({ kind: d.kind, hours, rate: d.amount, amount: hours * d.amount });
    running += d.amount;
  }
  // Additive stacking (UC–CNA Art. 14 §N, Title 38) takes every multiplier and the overtime
  // premium on the base rate alone; compound is the FLSA regular rate, each on the running rate.
  const additive = ctx.premiumStacking === 'additive';
  for (const d of applicable) {
    if (d.mode !== 'multiplier') continue;
    // Itemised as the increment this multiplier adds to the running rate, so the lines sum
    // to the total and a 1.0× multiplier shows as a $0 line rather than disappearing.
    const increment = (additive ? base : running) * (d.amount - 1);
    lines.push({ kind: d.kind, hours, rate: increment, amount: hours * increment });
    running = additive ? running + increment : running * d.amount;
  }
  // Partial clock differentials: under 38 U.S.C. 7453 the night differential and overtime are both
  // percentages of basic pay, so they never stack. Priced on the base rate and kept out of
  // `running` they neither compound with other multipliers nor lift the overtime rate; a FLSA
  // regular-rate unit that wants stacking sets the whole-shift threshold instead.
  const partial = clockDifferentials(view, ctx).partial;
  const onBase = (d: Differential, h: number) => {
    const rate = d.mode === 'flat' ? d.amount : base * (d.amount - 1);
    insertInOrder(lines, { kind: d.kind, hours: h, rate, amount: h * rate });
  };
  if (!baylorTour) for (const { d, hours: inWindow } of partial) onBase(d, inWindow);
  else {
    // A holdover is outside the tour, so § 7453 pays it again: on base, out of `running`, like a
    // partial clock differential, since § 7453 makes it and overtime both percentages of basic pay.
    const held = view.paidHours - view.scheduledHours;
    if (held > 0) {
      for (const d of earned) if (SECTION_7453_KINDS.has(d.kind)) onBase(d, held);
      const holdover: ShiftWindow = {
        startMinute: view.window.endMinute - held * MINUTES_PER_HOUR,
        endMinute: view.window.endMinute,
      };
      for (const { d } of partial) {
        const inWindow = hoursInDailyWindow(holdover, d.window!);
        if (inWindow > 0) onBase(d, inWindow);
      }
    }
  }
  const straightRate = running;

  let overtimeHours = 0;
  for (const band of overtime ?? []) {
    if (band.hours <= 0) continue;
    overtimeHours += band.hours;
    const rate = (additive ? base : straightRate) * (band.multiplier - 1);
    lines.push({ kind: 'overtime', hours: band.hours, rate, amount: band.hours * rate });
  }

  return {
    ...identity,
    baseRate: base,
    rateSource: resolved.source,
    straightRate,
    overtimeHours,
    lines,
    total: sum(lines),
  };
}

/** Every in-period assignment of one nurse, priced with overtime attributed across their week. */
function costTimeline(timeline: readonly AssignmentView[], ctx: CostContext): AssignmentCost[] {
  const overtime = attributeOvertime(timeline, ctx);
  const out: AssignmentCost[] = [];
  for (const view of timeline) {
    if (!view.inPeriod) continue;
    out.push(priceView(view, ctx, overtime.get(view)));
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

function emptyTotals(): CostTotals {
  const byKind = {} as Record<CostLineKind, number>;
  for (const kind of LINE_KINDS) byKind[kind] = 0;
  return {
    hours: 0,
    overtimeHours: 0,
    base: 0,
    differentials: 0,
    overtimePremium: 0,
    total: 0,
    byKind,
  };
}

function accumulate(into: CostTotals, cost: AssignmentCost): void {
  into.hours += cost.hours;
  into.overtimeHours += cost.overtimeHours;
  into.total += cost.total;
  for (const line of cost.lines) {
    into.byKind[line.kind] += line.amount;
    if (line.kind === 'base') into.base += line.amount;
    else if (line.kind === 'overtime') into.overtimePremium += line.amount;
    else into.differentials += line.amount;
  }
}

function concentration(nurses: readonly NurseCost[]): OvertimeConcentration {
  const totalHours = nurses.reduce((acc, n) => acc + n.overtimeHours, 0);
  const totalPremium = nurses.reduce((acc, n) => acc + n.overtimePremium, 0);
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
  const totals = emptyTotals();
  const unpricedNurseIds: Id[] = [];

  for (const nurseId of schedule.nursesById.keys()) {
    const costs = costNurse(schedule, ctx, nurseId);
    if (costs.length === 0) continue;
    const nurse: NurseCost = { ...emptyTotals(), nurseId, assignments: 0, unpricedAssignments: 0 };
    for (const cost of costs) {
      nurse.assignments++;
      if (cost.rateSource === 'none') nurse.unpricedAssignments++;
      accumulate(nurse, cost);
      accumulate(totals, cost);
      assignments.push(cost);
    }
    if (nurse.unpricedAssignments > 0) unpricedNurseIds.push(nurseId);
    nurses.push(nurse);
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
    totals,
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
  const before = costTimeline(timeline, ctx).reduce((acc, c) => acc + c.total, 0);

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
  const afterTotal = after.reduce((acc, c) => acc + c.total, 0);

  return { candidate, cost, delta: afterTotal - before };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export function compareToBudget(actualDollars: number, targetDollars: number): BudgetVariance {
  return {
    targetDollars,
    actualDollars,
    variance: actualDollars - targetDollars,
    ratio: targetDollars === 0 ? null : actualDollars / targetDollars,
  };
}
