/**
 * Hours rules — contracted hours, weekly caps and overtime authorisation.
 *
 * The unit runs mixed 8- and 12-hour shifts, so "did this nurse get their hours?" cannot be
 * answered by counting shifts. It has to be answered in hours, against each nurse's own FTE,
 * over the correct pay period. Part-time nurses being quietly over-scheduled and full-time
 * nurses being quietly under-scheduled are both contract problems, so the FTE rule reports
 * in both directions.
 */

import type { Id, Unit } from '../domain/entities.js';
import {
  addDays,
  compareDates,
  dayNumber,
  daysBetween,
  fromDayNumber,
  type IsoDate,
  type Weekday,
  weekdayOf,
} from '../domain/time.js';
import type { ScheduleView } from '../schedule/view.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

export interface DateWindow {
  start: IsoDate;
  end: IsoDate;
}

// ---------------------------------------------------------------------------
// Pay periods
// ---------------------------------------------------------------------------

/** Which pay period a date falls in, counted from the unit's anchor date. */
export function payPeriodIndex(date: IsoDate, unit: Unit): number {
  return Math.floor(daysBetween(unit.payPeriodAnchor, date) / unit.payPeriodDays);
}

export function payPeriodWindow(index: number, unit: Unit): DateWindow {
  const start = addDays(unit.payPeriodAnchor, index * unit.payPeriodDays);
  return { start, end: addDays(start, unit.payPeriodDays - 1) };
}

/**
 * Pay periods touching a schedule period.
 *
 * `onlyComplete` matters: a six-week schedule that ends mid-pay-period would otherwise
 * report every nurse as drastically under-hours for that final partial period, burying the
 * real violations in noise.
 */
export function payPeriodsIn(window: DateWindow, unit: Unit, onlyComplete: boolean): DateWindow[] {
  const first = payPeriodIndex(window.start, unit);
  const last = payPeriodIndex(window.end, unit);
  const out: DateWindow[] = [];
  for (let i = first; i <= last; i++) {
    const period = payPeriodWindow(i, unit);
    if (onlyComplete) {
      const fullyInside =
        compareDates(period.start, window.start) >= 0 && compareDates(period.end, window.end) <= 0;
      if (!fullyInside) continue;
    }
    out.push(period);
  }
  return out;
}

/** Fixed work weeks covering a window, aligned to the contract's week start. */
export function workWeeksIn(window: DateWindow, startsOn: Weekday): DateWindow[] {
  const firstDay = dayNumber(window.start);
  const shift = (weekdayOf(window.start) - startsOn + 7) % 7;
  const out: DateWindow[] = [];
  for (let day = firstDay - shift; day <= dayNumber(window.end); day += 7) {
    const start = fromDayNumber(day);
    out.push({ start, end: addDays(start, 6) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contracted hours / FTE
// ---------------------------------------------------------------------------

export interface ContractedHoursParams {
  /** Hours a nurse may fall short of their contracted total before it is a violation. */
  underToleranceHours: number;
  /** Hours a nurse may exceed it by. */
  overToleranceHours: number;
  /** Skip pay periods only partly covered by this schedule. Almost always correct. */
  onlyCompletePayPeriods: boolean;
  /** Per-diem nurses have no contracted minimum, so under-hours is not a violation for them. */
  exemptEmploymentTypes: string[];
  /** Whether standby hours count toward the contracted total. */
  onCallCountsTowardHours: boolean;
}

export const contractedHoursRule: Rule<ContractedHoursParams> = {
  id: 'fte-target-hours',
  name: 'Contracted hours (FTE)',
  description:
    "Each nurse's scheduled hours must land within tolerance of the hours their FTE entitles them " +
    'to, per pay period. Reports both shortfalls and overages.',
  severity: 'hard',
  category: 'hours',
  defaultParams: {
    underToleranceHours: 4,
    overToleranceHours: 4,
    onlyCompletePayPeriods: true,
    exemptEmploymentTypes: ['per_diem', 'agency'],
    onCallCountsTowardHours: false,
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    const periods = payPeriodsIn(
      { start: schedule.period.startDate, end: schedule.period.endDate },
      ctx.unit,
      params.onlyCompletePayPeriods,
    );
    if (periods.length === 0) return violations;

    for (const nurse of ctx.nurses) {
      if (!nurse.active) continue;
      const exempt = params.exemptEmploymentTypes.includes(nurse.employmentType);
      const timeline = schedule
        .assignmentsFor(nurse.id)
        .filter((v) => params.onCallCountsTowardHours || isWorked(v));

      for (const period of periods) {
        let hours = 0;
        const assignmentIds: Id[] = [];
        for (const view of timeline) {
          if (compareDates(view.assignment.date, period.start) < 0) continue;
          if (compareDates(view.assignment.date, period.end) > 0) continue;
          hours += view.paidHours;
          assignmentIds.push(view.assignment.id);
        }

        const target = nurse.contractedHoursPerPeriod;
        const delta = hours - target;

        if (!exempt && delta < -params.underToleranceHours) {
          violations.push(
            violation(
              contractedHoursRule,
              'hard',
              'under_contracted_hours',
              `${nurseName(nurse)} is scheduled ${hours}h in the pay period starting ${period.start}, ` +
                `${Math.abs(delta)}h short of their contracted ${target}h (${nurse.fte} FTE).`,
              {
                nurseIds: [nurse.id],
                dates: [period.start, period.end],
                assignmentIds,
                details: {
                  scheduledHours: hours,
                  targetHours: target,
                  deltaHours: delta,
                  payPeriod: period,
                },
              },
            ),
          );
        } else if (delta > params.overToleranceHours) {
          violations.push(
            violation(
              contractedHoursRule,
              'hard',
              'over_contracted_hours',
              `${nurseName(nurse)} is scheduled ${hours}h in the pay period starting ${period.start}, ` +
                `${delta}h over their contracted ${target}h (${nurse.fte} FTE).`,
              {
                nurseIds: [nurse.id],
                dates: [period.start, period.end],
                assignmentIds,
                details: {
                  scheduledHours: hours,
                  targetHours: target,
                  deltaHours: delta,
                  payPeriod: period,
                },
              },
            ),
          );
        }
      }
    }

    return violations;
  },
};

// ---------------------------------------------------------------------------
// Weekly hour caps and overtime authorisation
// ---------------------------------------------------------------------------

export interface MaxHoursParams {
  /** Absolute cap on hours in one work week, regardless of authorisation. */
  maxHoursPerWeek: number;
  /** Hours past which the week counts as overtime. */
  overtimeThresholdHours: number;
  /** The contract's work-week start. 0 = Sunday. */
  workWeekStartsOn: Weekday;
  /**
   * When true, a week over the overtime threshold must contain at least one assignment
   * explicitly marked as authorised overtime. Unauthorised overtime is a budget and contract
   * problem, so it is caught rather than silently costed.
   */
  requireOvertimeAuthorisation: boolean;
  onCallCountsTowardHours: boolean;
}

export const maxHoursRule: Rule<MaxHoursParams> = {
  id: 'max-hours-per-week',
  name: 'Weekly hour cap and overtime authorisation',
  description:
    'Caps hours in a single work week and requires overtime to be explicitly authorised rather than ' +
    'appearing by accident.',
  severity: 'hard',
  category: 'hours',
  defaultParams: {
    maxHoursPerWeek: 48,
    overtimeThresholdHours: 40,
    workWeekStartsOn: 0,
    requireOvertimeAuthorisation: true,
    onCallCountsTowardHours: false,
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    const weeks = workWeeksIn(
      { start: schedule.period.startDate, end: schedule.period.endDate },
      params.workWeekStartsOn,
    );

    for (const nurse of ctx.nurses) {
      const timeline = schedule
        .timelineFor(nurse.id)
        .filter((v) => params.onCallCountsTowardHours || isWorked(v));

      for (const week of weeks) {
        let hours = 0;
        let authorised = false;
        let touchesPeriod = false;
        const assignmentIds: Id[] = [];

        for (const view of timeline) {
          if (compareDates(view.assignment.date, week.start) < 0) continue;
          if (compareDates(view.assignment.date, week.end) > 0) continue;
          hours += view.paidHours;
          if (view.assignment.isOvertime) authorised = true;
          if (view.inPeriod) {
            touchesPeriod = true;
            assignmentIds.push(view.assignment.id);
          }
        }

        if (!touchesPeriod) continue;

        if (hours > params.maxHoursPerWeek) {
          violations.push(
            violation(
              maxHoursRule,
              'hard',
              'over_max_hours',
              `${nurseName(nurse)} is scheduled ${hours}h in the week of ${week.start}, over the ` +
                `${params.maxHoursPerWeek}h cap.`,
              {
                nurseIds: [nurse.id],
                dates: [week.start, week.end],
                assignmentIds,
                details: { scheduledHours: hours, maxHours: params.maxHoursPerWeek, week },
              },
            ),
          );
        } else if (
          params.requireOvertimeAuthorisation &&
          hours > params.overtimeThresholdHours &&
          !authorised
        ) {
          violations.push(
            violation(
              maxHoursRule,
              'hard',
              'unauthorised_overtime',
              `${nurseName(nurse)} is scheduled ${hours}h in the week of ${week.start}, which is ` +
                `${hours - params.overtimeThresholdHours}h of overtime, but no shift that week is ` +
                'marked as authorised overtime.',
              {
                nurseIds: [nurse.id],
                dates: [week.start, week.end],
                assignmentIds,
                details: {
                  scheduledHours: hours,
                  overtimeHours: hours - params.overtimeThresholdHours,
                  threshold: params.overtimeThresholdHours,
                  week,
                },
              },
            ),
          );
        }
      }
    }

    return violations;
  },
};

/** Hours a nurse is scheduled in the work week containing `date`. Used by the day-of finder. */
export function hoursInWeekOf(
  schedule: ScheduleView,
  nurseId: Id,
  date: IsoDate,
  startsOn: Weekday,
): number {
  const shift = (weekdayOf(date) - startsOn + 7) % 7;
  const start = addDays(date, -shift);
  return schedule.hoursBetween(nurseId, start, addDays(start, 6));
}
