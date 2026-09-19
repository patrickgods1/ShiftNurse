/**
 * Rest and fatigue rules — the clauses that exist because tired nurses hurt patients.
 *
 * These are the rules most likely to be violated by a well-meaning manual edit, because the
 * damage is invisible on a schedule grid: a night shift and the next morning's day shift sit
 * in different columns and look fine, while representing a nurse working sixteen of twenty
 * four hours.
 */

import type { Id } from '../domain/entities.js';
import { dayNumber, type IsoDate, minutesToHours, restMinutesBetween } from '../domain/time.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

// ---------------------------------------------------------------------------
// Minimum rest between shifts
// ---------------------------------------------------------------------------

export interface MinRestParams {
  /** Hours of rest required between the end of one shift and the start of the next. */
  minRestHours: number;
  /**
   * A longer requirement after a night shift, if the contract has one. Absent falls back to
   * `minRestHours`. Many contracts give extra recovery time coming off nights.
   */
  minRestHoursAfterNight?: number;
  /** Whether being on standby counts as working for rest purposes. Usually it does not. */
  onCallCountsAsWork: boolean;
}

export const minRestRule: Rule<MinRestParams> = {
  id: 'min-rest-between-shifts',
  name: 'Minimum rest between shifts',
  description:
    'Requires a minimum gap between the end of one shift and the start of the next. Catches the ' +
    'night-to-day turnaround, where a nurse finishes at 07:00 and is scheduled back at 07:00 or 15:00 ' +
    'the same day.',
  severity: 'hard',
  category: 'rest',
  scope: 'nurse',
  defaultParams: { minRestHours: 10, onCallCountsAsWork: false },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const nurse of ctx.nurses) {
      const timeline = schedule
        .timelineFor(nurse.id)
        .filter((v) => params.onCallCountsAsWork || isWorked(v));

      for (let i = 1; i < timeline.length; i++) {
        const previous = timeline[i - 1];
        const current = timeline[i];
        if (!previous || !current) continue;

        // Overlaps are a different violation entirely; let that rule own them.
        const restMinutes = restMinutesBetween(previous.window, current.window);
        if (restMinutes < 0) continue;

        const requiredHours =
          previous.shiftType.isNight && params.minRestHoursAfterNight !== undefined
            ? params.minRestHoursAfterNight
            : params.minRestHours;

        if (minutesToHours(restMinutes) >= requiredHours) continue;
        // History cannot be fixed; only flag when this schedule can do something about it.
        if (!previous.inPeriod && !current.inPeriod) continue;

        const restHours = minutesToHours(restMinutes);
        violations.push(
          violation(
            minRestRule,
            'hard',
            'insufficient_rest',
            `${nurseName(nurse)} has only ${formatHours(restHours)} off between the ` +
              `${previous.shiftType.name} on ${previous.assignment.date} and the ` +
              `${current.shiftType.name} on ${current.assignment.date}. ` +
              `${formatHours(requiredHours)} required.`,
            {
              nurseIds: [nurse.id],
              dates: [previous.assignment.date, current.assignment.date],
              assignmentIds: [previous.assignment.id, current.assignment.id],
              details: {
                restHours,
                requiredHours,
                shortfallHours: requiredHours - restHours,
                afterNightShift: previous.shiftType.isNight,
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
  allNights: boolean;
  touchesPeriod: boolean;
}

/**
 * Group a nurse's shifts into runs of consecutive calendar dates.
 *
 * Grouping by *start date* is what a nurse experiences as "days in a row": four night
 * shifts starting Mon–Thu is a four-day stretch, even though the last one ends Friday.
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
        allNights: true,
        touchesPeriod: false,
      };
    }
  }
  if (current) stretches.push(current);

  for (const stretch of stretches) {
    stretch.allNights = stretch.views.every((v) => v.shiftType.isNight);
    stretch.touchesPeriod = stretch.views.some((v) => v.inPeriod);
  }
  return stretches;
}

export const consecutiveShiftsRule: Rule<ConsecutiveShiftsParams> = {
  id: 'max-consecutive-shifts',
  name: 'Consecutive shift limits',
  description:
    'Caps how many days in a row a nurse may work, with a stricter cap on consecutive nights, and ' +
    'requires days off after a maximum-length stretch.',
  severity: 'hard',
  category: 'rest',
  scope: 'nurse',
  defaultParams: {
    maxConsecutiveShifts: 5,
    maxConsecutiveNights: 3,
    minDaysOffAfterMaxStretch: 2,
    onCallCountsAsWork: false,
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
              { actual: stretch.length, maximum: params.maxConsecutiveShifts },
            ),
          );
        }

        if (stretch.allNights && stretch.length > params.maxConsecutiveNights) {
          violations.push(
            stretchViolation(
              'too_many_consecutive_nights',
              `${nurseName(nurse)} is scheduled ${stretch.length} consecutive nights ` +
                `(${describeStretch(stretch)}). Maximum is ${params.maxConsecutiveNights}.`,
              nurse.id,
              stretch,
              { actual: stretch.length, maximum: params.maxConsecutiveNights, allNights: true },
            ),
          );
        }
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
                `${previous.length}-day stretch ending ${describeDay(previous.endDay)}. ` +
                `${params.minDaysOffAfterMaxStretch} required.`,
              nurse.id,
              next,
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
  stretch: Stretch,
  details: Record<string, unknown>,
): Violation {
  return violation(consecutiveShiftsRule, 'hard', code, message, {
    nurseIds: [nurseId],
    dates: stretch.views.filter((v) => v.inPeriod).map((v) => v.assignment.date),
    assignmentIds: stretch.views.filter((v) => v.inPeriod).map((v) => v.assignment.id),
    details,
  });
}

function describeStretch(stretch: Stretch): string {
  return `${describeDay(stretch.startDay)} to ${describeDay(stretch.endDay)}`;
}

function describeDay(day: number): IsoDate {
  return new Date(day * 86_400_000).toISOString().slice(0, 10) as IsoDate;
}

function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/** Convenience for the day-of replacement finder: would adding this shift break rest rules? */
export function restHoursAround(
  schedule: ScheduleView,
  nurseId: Id,
  candidate: { window: { startMinute: number; endMinute: number } },
): { beforeHours: number | null; afterHours: number | null } {
  const timeline = schedule.timelineFor(nurseId).filter(isWorked);
  let beforeHours: number | null = null;
  let afterHours: number | null = null;

  for (const view of timeline) {
    if (view.window.endMinute <= candidate.window.startMinute) {
      const gap = minutesToHours(candidate.window.startMinute - view.window.endMinute);
      beforeHours = beforeHours === null ? gap : Math.min(beforeHours, gap);
    } else if (view.window.startMinute >= candidate.window.endMinute) {
      const gap = minutesToHours(view.window.startMinute - candidate.window.endMinute);
      afterHours = afterHours === null ? gap : Math.min(afterHours, gap);
    }
  }
  return { beforeHours, afterHours };
}
