/**
 * Rest and fatigue rules — the clauses that exist because tired nurses hurt patients.
 *
 * These are the rules most likely to be violated by a well-meaning manual edit, because the
 * damage is invisible on a schedule grid: a night shift and the next morning's day shift sit
 * in different columns and look fine, while representing a nurse working sixteen of twenty
 * four hours.
 */

import type { Id } from '../domain/entities.js';
import {
  dayNumber,
  describeDate,
  describeDateRange,
  fromDayNumber,
  type IsoDate,
  minutesToHours,
  restMinutesBetween,
} from '../domain/time.js';
import { latestEndingBefore } from '../schedule/preceding.js';
import type { AssignmentView } from '../schedule/view.js';
import { hoursWords } from './format.js';
import { isNightTour } from './tour-rotation.js';
import {
  isWorked,
  nurseName,
  type Rule,
  type RuleContext,
  type Violation,
  violation,
} from './types.js';

// ---------------------------------------------------------------------------
// Minimum rest between shifts
// ---------------------------------------------------------------------------

export interface MinRestParams {
  /** Hours of rest required between the end of one shift and the start of the next. */
  minRestHours: number;
  /**
   * A longer requirement after a night tour, if the contract has one. Absent falls back to
   * `minRestHours`. Many contracts give extra recovery time coming off nights. A night is judged
   * by start time (`isNightTour`), so an evening tour paid as a night is not owed it.
   */
  minRestHoursAfterNight?: number;
  /** Whether being on standby counts as working for rest purposes. Usually it does not. */
  onCallCountsAsWork: boolean;
}

/**
 * Whether the nurse has waived minimum rest, in writing, before the shift that starts on `date`.
 * It is the later shift's date that counts (VA–NNU Art. 13 §2: the nurse waives the rest before
 * a tour), so a waiver never excuses the pair that ends on another day. CP-SAT's `encodeRest`
 * asks the same question, so both judge a turnaround alike.
 */
export function restWaivedOn(
  ctx: Pick<RuleContext, 'restWaiversByNurse'>,
  nurseId: Id,
  date: IsoDate,
): boolean {
  return ctx.restWaiversByNurse.get(nurseId)?.has(date) ?? false;
}

export const minRestRule: Rule<MinRestParams> = {
  id: 'min-rest-between-shifts',
  name: 'Minimum rest between shifts',
  description:
    'Requires a minimum gap between the end of one shift and the start of the next. Catches the ' +
    'night-to-day turnaround, where a nurse finishes at 07:00 and is scheduled back at 07:00 or 15:00 ' +
    'the same day. A nurse’s written waiver (Roster › Rest waivers) excuses the shift that starts on its ' +
    'date.',
  severity: 'hard',
  category: 'rest',
  scope: 'nurse',
  defaultParams: { minRestHours: 10, onCallCountsAsWork: false },
  paramDocs: {
    minRestHours: {
      label: 'Minimum rest (hours)',
      hint: 'Hours off a nurse must have between the end of one shift and the start of the next.',
      why:
        'Set it to what your contract says; 8 to 12 hours is typical in the US. A higher number ' +
        'protects against fatigue but leaves fewer ways to fill a hole, so the solver may leave ' +
        'more shifts short.',
    },
    minRestHoursAfterNight: {
      label: 'Minimum rest after a night (hours)',
      hint: 'A longer rest after a night shift. Leave blank to use the minimum rest above.',
      why:
        'Many contracts give extra recovery coming off nights, for example 12 or 24 hours before ' +
        'the next shift. Set it if yours does.',
      optional: true,
    },
    onCallCountsAsWork: {
      label: 'On-call counts as work',
      hint: 'Whether a standby shift needs the same rest before and after it as a worked shift.',
      why:
        'Usually off: a nurse on standby is resting unless called in. Turn it on if your contract ' +
        'treats being on call as working time for rest.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const nurse of ctx.nurses) {
      const timeline = schedule
        .timelineFor(nurse.id)
        .filter((v) => params.onCallCountsAsWork || isWorked(v));

      const preceding = latestEndingBefore(timeline);
      const requiredAfter = (v: AssignmentView) =>
        isNightTour(v.shiftType) && params.minRestHoursAfterNight !== undefined
          ? params.minRestHoursAfterNight
          : params.minRestHours;

      for (let i = 0; i < timeline.length; i++) {
        const current = timeline[i]!;
        // Rest starts when the nurse last stopped working, so a short shift nested inside a night
        // does not stand in for the night's end.
        const before = preceding[i]!;
        const first = before[0];
        if (!first) continue;

        // Overlaps are a different violation entirely; let that rule own them.
        const restMinutes = restMinutesBetween(first.window, current.window);
        if (restMinutes < 0) continue;

        // Several shifts can end at that minute; the longest rest any of them is owed applies.
        let previous = first;
        for (const p of before) if (requiredAfter(p) > requiredAfter(previous)) previous = p;
        const requiredHours = requiredAfter(previous);

        if (minutesToHours(restMinutes) >= requiredHours) continue;
        // Waived in writing for the shift that follows: the turnaround stands.
        if (restWaivedOn(ctx, nurse.id, current.assignment.date)) continue;
        // History cannot be fixed; only flag when this schedule can do something about it.
        if (!previous.inPeriod && !current.inPeriod) continue;

        const restHours = minutesToHours(restMinutes);
        // The lookback row is history: the finding names only what this schedule can change.
        const inPeriodPair = [previous, current].filter((v) => v.inPeriod);
        violations.push(
          violation(
            minRestRule,
            'hard',
            'insufficient_rest',
            `${nurseName(nurse)} has only ${hoursWords(restHours)} off between the ` +
              `${previous.shiftType.name} on ${describeDate(previous.assignment.date)} and the ` +
              `${current.shiftType.name} on ${describeDate(current.assignment.date)}. ` +
              `${hoursWords(requiredHours)} required.`,
            {
              amount: requiredHours - restHours,
              nurseIds: [nurse.id],
              dates: inPeriodPair.map((v) => v.assignment.date),
              assignmentIds: inPeriodPair.map((v) => v.assignment.id),
              details: {
                restHours,
                requiredHours,
                shortfallHours: requiredHours - restHours,
                afterNightShift: isNightTour(previous.shiftType),
              },
            },
          ),
        );
      }
    }

    return violations;
  },
};

// ---------------------------------------------------------------------------
// Consecutive shifts and nights
// ---------------------------------------------------------------------------

export interface ConsecutiveShiftsParams {
  /** Maximum shifts worked on consecutive calendar days. */
  maxConsecutiveShifts: number;
  /** Maximum consecutive night shifts, usually stricter than the general limit. */
  maxConsecutiveNights: number;
  /** Days off required after working a full-length stretch. */
  minDaysOffAfterMaxStretch: number;
  onCallCountsAsWork: boolean;
}

/** A run of shifts on consecutive calendar dates. */
interface Stretch {
  startDay: number;
  endDay: number;
  views: AssignmentView[];
  length: number;
  touchesPeriod: boolean;
}

/**
 * Group a nurse's shifts into runs of consecutive calendar dates.
 *
 * Grouping by *start date* is what a nurse experiences as "days in a row": four night
 * shifts starting Mon–Thu is a four-day stretch, even though the last one ends Friday.
 * Days off are counted the same way — a day off is a calendar day with no shift starting on it,
 * so the Saturday a Friday night ends on counts as one (D5's reading).
 */
export function buildStretches(views: readonly AssignmentView[]): Stretch[] {
  const byDay = new Map<number, AssignmentView[]>();
  for (const view of views) {
    const day = dayNumber(view.assignment.date);
    const existing = byDay.get(day);
    if (existing) existing.push(view);
    else byDay.set(day, [view]);
  }

  const days = [...byDay.keys()].sort((a, b) => a - b);
  const stretches: Stretch[] = [];
  let current: Stretch | null = null;

  for (const day of days) {
    const dayViews = byDay.get(day) ?? [];
    if (current && day === current.endDay + 1) {
      current.endDay = day;
      current.views.push(...dayViews);
      current.length++;
    } else {
      if (current) stretches.push(current);
      current = {
        startDay: day,
        endDay: day,
        views: [...dayViews],
        length: 1,
        touchesPeriod: false,
      };
    }
  }
  if (current) stretches.push(current);

  for (const stretch of stretches) {
    stretch.touchesPeriod = stretch.views.some((v) => v.inPeriod);
  }
  return stretches;
}

/** A run of consecutive dates each with a worked night tour starting on it. */
export interface NightRun {
  startDay: number;
  endDay: number;
  length: number;
  /** The worked-night views dated in the run, lookback included; never a day shift beside them. */
  views: AssignmentView[];
  touchesPeriod: boolean;
}

/**
 * Group a nurse's worked nights into runs of consecutive night dates (D1).
 *
 * The night cap is about sleep, so it counts the nights in a row wherever they sit: a day shift
 * before or after them neither resets the count nor hides it. Judging only stretches made
 * entirely of nights let "day Monday, nights Tuesday to Friday" pass as no night run at all.
 * Standby never makes a night date, even where on-call counts toward days in a row: a nurse on
 * call is not awake on the floor. A night is a night tour (`isNightTour`), not the pay flag.
 */
export function nightRuns(views: readonly AssignmentView[]): NightRun[] {
  const byDay = new Map<number, AssignmentView[]>();
  for (const view of views) {
    if (view.shiftType.isOnCall || !isNightTour(view.shiftType)) continue;
    const day = dayNumber(view.assignment.date);
    const existing = byDay.get(day);
    if (existing) existing.push(view);
    else byDay.set(day, [view]);
  }

  const days = [...byDay.keys()].sort((a, b) => a - b);
  const runs: NightRun[] = [];
  let current: NightRun | null = null;
  for (const day of days) {
    const dayViews = byDay.get(day)!;
    if (current && day === current.endDay + 1) {
      current.endDay = day;
      current.views.push(...dayViews);
      current.length++;
    } else {
      if (current) runs.push(current);
      current = {
        startDay: day,
        endDay: day,
        views: [...dayViews],
        length: 1,
        touchesPeriod: false,
      };
    }
  }
  if (current) runs.push(current);

  for (const run of runs) run.touchesPeriod = run.views.some((v) => v.inPeriod);
  return runs;
}

export const consecutiveShiftsRule: Rule<ConsecutiveShiftsParams> = {
  id: 'max-consecutive-shifts',
  name: 'Consecutive shift limits',
  description:
    'Caps how many days in a row a nurse may work and how many nights in a row (counted wherever ' +
    'they sit in the run), and requires days off after a maximum-length stretch.',
  severity: 'hard',
  category: 'rest',
  scope: 'nurse',
  defaultParams: {
    maxConsecutiveShifts: 5,
    maxConsecutiveNights: 3,
    minDaysOffAfterMaxStretch: 2,
    onCallCountsAsWork: false,
  },
  paramDocs: {
    maxConsecutiveShifts: {
      label: 'Most days in a row',
      min: 1,
      hint: 'The longest run of consecutive days a nurse may work, days and nights mixed.',
      why:
        'Contracts commonly allow 4 to 6. Lower it to limit fatigue; raise it only if your ' +
        'contract allows longer stretches and you are short of ways to cover.',
    },
    maxConsecutiveNights: {
      label: 'Most nights in a row',
      min: 1,
      hint:
        'The longest run of nights in a row, wherever it sits: a day shift before or after the ' +
        'nights does not change the count.',
      why:
        'Three or four nights in a row is a common ceiling, because nights are harder on sleep. ' +
        'A night is a shift starting between 18:00 and 03:59, whatever its pay flag.',
    },
    minDaysOffAfterMaxStretch: {
      label: 'Days off after a longest run',
      hint:
        'Days off required after a nurse works the most days in a row allowed. 0 turns it off. ' +
        'A day off is a calendar day with no shift starting on it, so the Saturday a Friday night ' +
        'ends on counts.',
      why:
        'Many contracts require two days off after a full stretch so staff recover before the ' +
        'next one. Set it to what your contract says.',
    },
    onCallCountsAsWork: {
      label: 'On-call counts as work',
      hint: 'Whether a standby shift counts as a day worked in a run.',
      why:
        'Usually off. Turn it on if your contract counts days on call toward consecutive-day ' +
        'limits.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const nurse of ctx.nurses) {
      const timeline = schedule
        .timelineFor(nurse.id)
        .filter((v) => params.onCallCountsAsWork || isWorked(v));
      const stretches = buildStretches(timeline);

      for (const stretch of stretches) {
        if (!stretch.touchesPeriod) continue;

        if (stretch.length > params.maxConsecutiveShifts) {
          violations.push(
            stretchViolation(
              'too_many_consecutive_shifts',
              `${nurseName(nurse)} is scheduled ${stretch.length} days in a row ` +
                `(${describeStretch(stretch)}). Maximum is ${params.maxConsecutiveShifts}.`,
              nurse.id,
              stretch,
              stretch.length - params.maxConsecutiveShifts,
              { actual: stretch.length, maximum: params.maxConsecutiveShifts },
            ),
          );
        }
      }

      for (const run of nightRuns(timeline)) {
        if (!run.touchesPeriod || run.length <= params.maxConsecutiveNights) continue;
        violations.push(
          stretchViolation(
            'too_many_consecutive_nights',
            `${nurseName(nurse)} is scheduled ${run.length} nights in a row ` +
              `(${describeStretch(run)}). Maximum is ${params.maxConsecutiveNights}.`,
            nurse.id,
            run,
            run.length - params.maxConsecutiveNights,
            { actual: run.length, maximum: params.maxConsecutiveNights },
          ),
        );
      }

      // Recovery days between back-to-back maximum stretches.
      if (params.minDaysOffAfterMaxStretch > 0) {
        for (let i = 1; i < stretches.length; i++) {
          const previous = stretches[i - 1];
          const next = stretches[i];
          if (!previous || !next) continue;
          if (previous.length < params.maxConsecutiveShifts) continue;
          if (!previous.touchesPeriod && !next.touchesPeriod) continue;

          const daysOff = next.startDay - previous.endDay - 1;
          if (daysOff >= params.minDaysOffAfterMaxStretch) continue;

          violations.push(
            stretchViolation(
              'missing_required_days_off',
              `${nurseName(nurse)} gets only ${daysOff} day${daysOff === 1 ? '' : 's'} off after a ` +
                `${previous.length}-day stretch ending ${describeDate(fromDayNumber(previous.endDay))}. ` +
                `${params.minDaysOffAfterMaxStretch} required.`,
              nurse.id,
              // Taking away a shift of either stretch gives the days off back.
              { views: [...previous.views, ...next.views] },
              params.minDaysOffAfterMaxStretch - daysOff,
              {
                daysOff,
                required: params.minDaysOffAfterMaxStretch,
                previousStretchLength: previous.length,
              },
            ),
          );
        }
      }
    }

    return violations;
  },
};

function stretchViolation(
  code: 'too_many_consecutive_shifts' | 'too_many_consecutive_nights' | 'missing_required_days_off',
  message: string,
  nurseId: Id,
  stretch: Pick<Stretch, 'views'>,
  amount: number,
  details: Record<string, unknown>,
): Violation {
  return violation(consecutiveShiftsRule, 'hard', code, message, {
    amount,
    nurseIds: [nurseId],
    dates: stretch.views.filter((v) => v.inPeriod).map((v) => v.assignment.date),
    assignmentIds: stretch.views.filter((v) => v.inPeriod).map((v) => v.assignment.id),
    details,
  });
}

function describeStretch(stretch: Pick<Stretch, 'startDay' | 'endDay'>): string {
  return describeDateRange(fromDayNumber(stretch.startDay), fromDayNumber(stretch.endDay));
}
