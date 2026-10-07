/**
 * Fairness ledger derivation — turns a solved period into the burden counters the score, the
 * historical burden window and the CSV importer all read.
 *
 * ## Why this is a separate pass over the schedule, not folded into the rules
 *
 * Rules answer "is this schedule legal?" and stop at the first hard failure that matters.
 * Fairness has to answer a different question — "how much of the unpleasant work did each
 * nurse actually carry, and how well did we honour what they asked for?" — for *every* nurse,
 * every time, even on a perfectly legal schedule. That is a full accounting pass, not a
 * constraint check, so it lives here rather than as another `Rule`.
 *
 * Every counter here is computed from in-period assignments only (`schedule.assignmentsFor`),
 * never the lookback tail: the tail exists so rest/consecutive-shift rules can see across a
 * period boundary, but crediting or blaming a nurse for a shift a *previous* schedule assigned
 * would double-count it in that period's own ledger row.
 */

import { isBaylorPlan } from '../cost/cost.js';
import type { Id, Preference } from '../domain/entities.js';
import {
  dateInRange,
  type IsoDate,
  isWeekendWindow,
  shiftWindow,
  type WeekendDefinition,
  weekdayOf,
  weekendKey,
} from '../domain/time.js';
import { buildStretches } from '../rules/rest-rules.js';
import { isWorked } from '../rules/types.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import type { BurdenCounters, CounterContext, NurseOccurrences } from './types.js';

// ---------------------------------------------------------------------------
// Undesirable shifts
// ---------------------------------------------------------------------------

/**
 * A shift is "undesirable" when it runs against something the nurse explicitly asked to avoid.
 * Only `avoid_*` preferences count here — an unmet `prefer_*` is a missed opportunity, not an
 * imposition, and is already captured by `preferenceHitRate` rather than this stronger signal.
 *
 * Callers pass a worked shift's view; on-call standby is never "undesirable" by this measure
 * because it isn't worked bedside time.
 */
export function isUndesirable(
  view: AssignmentView,
  prefs: readonly Preference[],
  weekendDefinition: WeekendDefinition,
): boolean {
  return preferencesBroken(view, prefs, weekendDefinition).length > 0;
}

/**
 * The preferences this shift goes against: the same test as `isUndesirable`, kept as the list so
 * the grid can say which ("avoids nights") rather than only that one was broken.
 */
export function preferencesBroken(
  view: Pick<AssignmentView, 'assignment' | 'window'>,
  prefs: readonly Preference[],
  weekendDefinition: WeekendDefinition,
): Preference[] {
  return prefs.filter(
    (pref) =>
      (pref.kind === 'avoid_shift_type' && view.assignment.shiftTypeId === pref.shiftTypeId) ||
      (pref.kind === 'avoid_weekday' && weekdayOf(view.assignment.date) === pref.weekday) ||
      (pref.kind === 'weekend_appetite' &&
        pref.level < 0 &&
        isWeekendWindow(view.window, weekendDefinition)),
  );
}

// ---------------------------------------------------------------------------
// Preference satisfaction
// ---------------------------------------------------------------------------

/** How many dates in `dates` fall on the given weekday. */
function countWeekday(dates: readonly IsoDate[], weekday: number): number {
  let count = 0;
  for (const date of dates) {
    if (weekdayOf(date) === weekday) count++;
  }
  return count;
}

/**
 * Distinct weekends the period's calendar touches, independent of who worked them. A date has
 * no shift window of its own, so this stands a synthetic midnight-to-midnight window in for
 * one, which is enough to ask "does this calendar day fall in a weekend window" without
 * inventing a shift that was never scheduled.
 */
function weekendKeysInDates(dates: readonly IsoDate[], def: WeekendDefinition): number {
  const keys = new Set<string>();
  for (const date of dates) {
    const window = shiftWindow(date, { startTime: '00:00', durationHours: 24 });
    const key = weekendKey(window, def);
    if (key !== null) keys.add(key);
  }
  return keys.size;
}

/**
 * 0–1: how well one preference was honoured by a nurse's (in-period) assignment views over the
 * period's dates. A nurse who worked nothing had nothing dishonoured, so every kind reads as a
 * full 1 in that case — an empty schedule is neutral, not a broken promise.
 */
export function preferenceSatisfaction(
  pref: Preference,
  views: readonly AssignmentView[],
  dates: readonly IsoDate[],
  weekendDefinition: WeekendDefinition,
  holidayDateById?: ReadonlyMap<Id, IsoDate>,
): number {
  const workedViews = views.filter(isWorked);
  if (workedViews.length === 0) return 1;

  switch (pref.kind) {
    case 'prefer_shift_type': {
      const matches = workedViews.filter((v) => v.assignment.shiftTypeId === pref.shiftTypeId);
      return matches.length / workedViews.length;
    }
    case 'avoid_shift_type': {
      const matches = workedViews.filter((v) => v.assignment.shiftTypeId === pref.shiftTypeId);
      return 1 - matches.length / workedViews.length;
    }
    case 'prefer_weekday': {
      const onWeekday = workedViews.filter(
        (v) => weekdayOf(v.assignment.date) === pref.weekday,
      ).length;
      const weekdayCount = countWeekday(dates, pref.weekday);
      const denom = Math.min(weekdayCount, workedViews.length);
      // No opportunity to satisfy it either way — nothing was dishonoured.
      if (denom === 0) return 1;
      return Math.min(1, onWeekday / denom);
    }
    case 'avoid_weekday': {
      const onWeekday = workedViews.filter(
        (v) => weekdayOf(v.assignment.date) === pref.weekday,
      ).length;
      const weekdayCount = countWeekday(dates, pref.weekday);
      if (weekdayCount === 0) return 1;
      return 1 - onWeekday / weekdayCount;
    }
    case 'weekend_appetite': {
      // Neutral means the nurse expressed no opinion, so there is nothing to score.
      if (pref.level === 0) return 1;
      const weekendsWorked = new Set(
        workedViews
          .map((v) => weekendKey(v.window, weekendDefinition))
          .filter((k): k is string => k !== null),
      ).size;
      const weekendsInPeriod = weekendKeysInDates(dates, weekendDefinition);
      if (weekendsInPeriod === 0) return 1;
      if (pref.level < 0) {
        return 1 - weekendsWorked / weekendsInPeriod;
      }
      // Wanting weekends is satisfied once the nurse carries their fair share of them —
      // "every other weekend" is the common contract phrasing, hence the half-share target.
      const fairShare = Math.ceil(weekendsInPeriod / 2);
      if (fairShare === 0) return 1;
      return Math.min(1, weekendsWorked / fairShare);
    }
    case 'holiday_appetite': {
      // Met by working the holiday, as a weekend appetite is by working weekends; a holiday this
      // period does not hold offered no chance either way.
      const date = holidayDateById?.get(pref.holidayId);
      if (date === undefined || !dates.includes(date)) return 1;
      return workedViews.some((v) => v.assignment.date === date) ? 1 : 0;
    }
    case 'preferred_block_length': {
      // Stretches are built from the full timeline, not just worked shifts: an on-call day
      // still breaks (or extends) how many days in a row a nurse is tied to the unit, which is
      // what "block length" means to someone living it.
      const stretches = buildStretches(views);
      if (stretches.length === 0) return 1;
      const within = stretches.filter((s) => Math.abs(s.length - pref.shifts) <= 1).length;
      return within / stretches.length;
    }
    default: {
      const exhaustive: never = pref;
      throw new Error(`Unhandled preference kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Weighted mean of `preferenceSatisfaction` across one nurse's preferences. A nurse with no
 * preferences (or only neutral ones) has nothing to fall short of, so the rate is a full 1
 * rather than an undefined or zero average.
 */
function weightedPreferenceHitRate(
  prefs: readonly Preference[],
  views: readonly AssignmentView[],
  dates: readonly IsoDate[],
  weekendDefinition: WeekendDefinition,
  holidayDateById: ReadonlyMap<Id, IsoDate> | undefined,
): number {
  let weightSum = 0;
  let scoreSum = 0;
  for (const pref of prefs) {
    // A neutral weekend appetite is not a preference at all; counting it would drag every
    // nurse's rate toward 1 regardless of how their actual preferences fared.
    if (pref.kind === 'weekend_appetite' && pref.level === 0) continue;
    // Likewise a wish to work a holiday this period does not hold: a Christmas volunteer would
    // otherwise score a free full mark in every schedule of the year.
    if (pref.kind === 'holiday_appetite') {
      const date = holidayDateById?.get(pref.holidayId);
      if (date === undefined || !dates.includes(date)) continue;
    }
    scoreSum +=
      preferenceSatisfaction(pref, views, dates, weekendDefinition, holidayDateById) * pref.weight;
    weightSum += pref.weight;
  }
  return weightSum === 0 ? 1 : scoreSum / weightSum;
}

// ---------------------------------------------------------------------------
// What counts as a burden — the one definition, shared by the counters and the date lists
// ---------------------------------------------------------------------------

const countsAsNight = (view: AssignmentView): boolean => view.shiftType.isNight;

// Shifts are dated by their start day, so a night shift running into a holiday morning
// is not "worked on" the holiday — the nurse clocked in the day before.
const countsAsHoliday = (view: AssignmentView, ctx: CounterContext): boolean =>
  ctx.holidayDates.has(view.assignment.date);

// A nurse on the Baylor plan (38 U.S.C. § 7456) works every weekend by contract and has no holiday
// entitlement; counting either as burden would make their score a complaint about their own plan,
// and push the fairness pressure onto the nurses who were never hired for weekends. `isBaylorPlan`
// is the test the rules and both solvers' counters use, so Generate prices what the ledger records.

// ---------------------------------------------------------------------------
// Counter derivation
// ---------------------------------------------------------------------------

/**
 * This period's burden counters for every nurse in `schedule.nursesById`. Built from in-period
 * assignments only (`schedule.assignmentsFor`) — see the module header for why the lookback
 * tail is deliberately excluded.
 */
function groupByNurse<T extends { nurseId: Id }>(rows: readonly T[]): Map<Id, T[]> {
  const out = new Map<Id, T[]>();
  for (const row of rows) {
    const list = out.get(row.nurseId);
    if (list) list.push(row);
    else out.set(row.nurseId, [row]);
  }
  return out;
}

export function deriveCounters(
  schedule: ScheduleView,
  ctx: CounterContext,
  /** Only these nurses: a simulated fix re-derives the few it touched and keeps the rest. */
  only?: ReadonlySet<Id>,
): Map<Id, BurdenCounters> {
  const result = new Map<Id, BurdenCounters>();
  const periodDays = schedule.dates.length;
  // Grouped once: filtering every preference and request per nurse made this quadratic.
  const prefsByNurse = groupByNurse(ctx.preferences);
  const timeOffByNurse = groupByNurse(ctx.timeOff ?? []);

  for (const [nurseId, nurse] of schedule.nursesById) {
    if (only !== undefined && !only.has(nurseId)) continue;
    const views = schedule.assignmentsFor(nurseId);
    const workedViews = views.filter(isWorked);
    const nursePrefs = prefsByNurse.get(nurseId) ?? [];

    let nightShifts = 0;
    let holidaysWorked = 0;
    let undesirableShifts = 0;
    let totalHours = 0;
    const weekendKeysWorked = new Set<string>();
    const burdened = !isBaylorPlan(nurse);
    for (const view of workedViews) {
      if (countsAsNight(view)) nightShifts++;
      if (burdened && countsAsHoliday(view, ctx)) holidaysWorked++;
      if (isUndesirable(view, nursePrefs, ctx.weekendDefinition)) undesirableShifts++;
      totalHours += view.paidHours;
      const key = weekendKey(view.window, ctx.weekendDefinition);
      if (burdened && key !== null) weekendKeysWorked.add(key);
    }

    let onCallShifts = 0;
    let callOutsCovered = 0;
    for (const view of views) {
      if (view.shiftType.isOnCall) onCallShifts++;
      if (view.assignment.source === 'callout') callOutsCovered++;
    }

    let requestsApproved = 0;
    let requestsDenied = 0;
    for (const request of timeOffByNurse.get(nurseId) ?? []) {
      if (!dateInRange(request.startDate, schedule.period.startDate, schedule.period.endDate)) {
        continue;
      }
      if (request.status === 'approved') requestsApproved++;
      else if (request.status === 'denied') requestsDenied++;
    }

    // Per-diem nurses (contractedHoursPerPeriod 0) have no hours floor, so there is no
    // baseline to be "over" — charging them overtime here would invent a violation out of a
    // target that was never set.
    const contracted =
      nurse.contractedHoursPerPeriod === 0
        ? 0
        : (nurse.contractedHoursPerPeriod * periodDays) / ctx.unit.payPeriodDays;
    const overtimeHours =
      nurse.contractedHoursPerPeriod === 0 ? 0 : Math.max(0, totalHours - contracted);

    const preferenceHitRate = weightedPreferenceHitRate(
      nursePrefs,
      views,
      schedule.dates,
      ctx.weekendDefinition,
      ctx.holidayDateById,
    );

    result.set(nurseId, {
      nightShifts,
      weekendsWorked: weekendKeysWorked.size,
      holidaysWorked,
      onCallShifts,
      undesirableShifts,
      requestsApproved,
      requestsDenied,
      callOutsCovered,
      totalHours,
      overtimeHours,
      preferenceHitRate,
    });
  }

  return result;
}

/**
 * The dates behind the counters, per nurse, for the same in-period worked shifts: "why is Ana
 * on four weekends" needs the days, not the tally. Sorted, one entry per date (a weekend day
 * with two shifts is one day). Weekends are listed per day worked where the ledger counts per
 * weekend, so a Saturday plus Sunday is two entries against `weekendsWorked` of 1.
 */
export function deriveOccurrences(
  schedule: ScheduleView,
  ctx: CounterContext,
): Map<Id, NurseOccurrences> {
  const result = new Map<Id, NurseOccurrences>();
  for (const [nurseId, nurse] of schedule.nursesById) {
    const nights = new Set<IsoDate>();
    const weekends = new Set<IsoDate>();
    const holidays = new Set<IsoDate>();
    const burdened = !isBaylorPlan(nurse);
    for (const view of schedule.assignmentsFor(nurseId).filter(isWorked)) {
      const date = view.assignment.date;
      if (countsAsNight(view)) nights.add(date);
      if (burdened && weekendKey(view.window, ctx.weekendDefinition) !== null) {
        weekends.add(date);
      }
      if (burdened && countsAsHoliday(view, ctx)) holidays.add(date);
    }
    // ISO dates sort in calendar order as strings.
    const sorted = (set: Set<IsoDate>): IsoDate[] => [...set].sort();
    result.set(nurseId, {
      nights: sorted(nights),
      weekends: sorted(weekends),
      holidays: sorted(holidays),
    });
  }
  return result;
}
