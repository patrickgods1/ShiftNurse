/**
 * How many weekends a nurse works: in a row, in one schedule, and in any four weeks.
 *
 * "Every other weekend off" is among the most common contract terms in nursing, and the burden
 * fairness balances weekends across the team without ever saying no to a fourth in a row for one
 * nurse — a team can be fair on average while one nurse works every weekend of a month. This rule
 * reads the pattern itself: a weekend worked is one with any worked (not standby) shift in it, as
 * the unit's weekend definition and the fairness ledger read it (`weekendKey`); a run counts
 * weekends from the period before, so a schedule cannot open on someone's third weekend running.
 *
 * "Two weekends off in four" (VA–NNU Master Agreement Art. 13) is judged over each trailing window
 * of four weekends, lookback included, not per schedule: a per-schedule cap of 2 lets a 4-week
 * schedule starting on a Sunday touch five weekends, and a 6-week one would allow 3 of 6. The
 * window reads the same whatever length the unit cuts its schedules.
 *
 * Soft by default and off until a unit turns it on. Both solvers price each breach
 * (`weekendPattern`, fairness bucket); hard, it forbids the run outright.
 *
 * A nurse on the Baylor plan (38 U.S.C. § 7456) works every weekend by contract, so this rule does
 * not judge them (`judgesWeekends`), and neither solver prices or forbids their weekends: a cap
 * would flag the plan itself, and make Generate steer the very nurses hired for weekends off them.
 */

import { isBaylorPlan } from '../cost/cost.js';
import type { Nurse } from '../domain/entities.js';
import { addDays, compareDates, describeDate, type IsoDate, weekendKey } from '../domain/time.js';
import type { ScheduleView } from '../schedule/view.js';
import type { Rule, RuleContext, Violation } from './types.js';
import { isWorked, nurseName, violation } from './types.js';

export interface WeekendPatternParams {
  /** Weekends in a row a nurse may work; 1 is "every other weekend". */
  maxConsecutiveWeekends: number;
  /** Weekends a nurse may work in one schedule. Absent: no limit. */
  maxWeekendsPerPeriod?: number;
  /** Weekends a nurse may work in any four in a row, across schedules. Absent: no limit. */
  maxWeekendsPer4Weeks?: number;
}

/** One nurse's weekends, by the Saturday-style key the weekend definition gives them. */
export interface NurseWeekends {
  /** Every weekend worked, the period before included. */
  worked: ReadonlySet<IsoDate>;
  /** The weekends worked inside this period. */
  inPeriod: ReadonlySet<IsoDate>;
}

export interface WeekendBreaches {
  /** In-period weekends that end a run longer than allowed, each with the run's length. */
  runs: { weekend: IsoDate; length: number }[];
  /** In-period weekends past the per-schedule limit. */
  excess: number;
  /**
   * In-period worked weekends whose four-week window (it and the three before) holds more than
   * the limit, each with the weekends worked in it and how many past the limit. Overlapping
   * windows each count, so a fourth weekend in four costs more than a third, as runs do.
   */
  windows: { weekend: IsoDate; worked: number; excess: number }[];
}

/**
 * The one count of weekend breaches, shared by the rule and both solvers. A weekend breaches the
 * run limit when it and the `max` weekends before it were all worked; the price is one per such
 * weekend, plus one per weekend over the per-schedule limit, plus each window's excess.
 */
export function weekendBreaches(
  weekends: NurseWeekends,
  params: WeekendPatternParams,
): WeekendBreaches {
  const max = Math.max(0, Math.floor(params.maxConsecutiveWeekends));
  const perFour = params.maxWeekendsPer4Weeks;
  const runs: WeekendBreaches['runs'] = [];
  const windows: WeekendBreaches['windows'] = [];
  for (const weekend of [...weekends.inPeriod].sort(compareDates)) {
    let length = 1;
    while (weekends.worked.has(addDays(weekend, -7 * length))) length++;
    if (length > max) runs.push({ weekend, length });
    if (perFour !== undefined) {
      let worked = 1;
      for (let back = 1; back < 4; back++) {
        if (weekends.worked.has(addDays(weekend, -7 * back))) worked++;
      }
      const over = worked - Math.floor(perFour);
      if (over > 0) windows.push({ weekend, worked, excess: over });
    }
  }
  const limit = params.maxWeekendsPerPeriod;
  const excess = limit === undefined ? 0 : Math.max(0, weekends.inPeriod.size - Math.floor(limit));
  return { runs, excess, windows };
}

/** Whether this rule judges the nurse's weekends; shared by the rule and both solvers. */
export function judgesWeekends(nurse: Pick<Nurse, 'scheduleKind'>): boolean {
  return !isBaylorPlan(nurse);
}

/** The weekends one nurse works on a view (their timeline, lookback tail included). */
export function nurseWeekends(
  schedule: ScheduleView,
  nurseId: string,
  ctx: Pick<RuleContext, 'weekendDefinition'>,
): NurseWeekends {
  const worked = new Set<IsoDate>();
  const inPeriod = new Set<IsoDate>();
  for (const view of schedule.timelineFor(nurseId)) {
    if (!isWorked(view)) continue;
    const key = weekendKey(view.window, ctx.weekendDefinition) as IsoDate | null;
    if (key === null) continue;
    worked.add(key);
    if (view.inPeriod) inPeriod.add(key);
  }
  return { worked, inPeriod };
}

export const weekendPatternRule: Rule<WeekendPatternParams> = {
  id: 'weekend-pattern',
  name: 'Weekends in a row, per schedule and in four weeks',
  description:
    'Limits how many weekends in a row a nurse works ("every other weekend off") and, if set, ' +
    'how many in one schedule and in any four weeks in a row. Weekends from the schedule ' +
    'before count toward a run and toward the four weeks.',
  severity: 'soft',
  category: 'equity',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { maxConsecutiveWeekends: 1 },
  paramDocs: {
    maxConsecutiveWeekends: {
      label: 'Weekends in a row',
      hint: 'The most weekends in a row a nurse works. 1 means every other weekend off.',
      why:
        'Set it to what the contract promises. Many give every other weekend off; some units ' +
        'with weekend-only staff allow 2 or more.',
      min: 1,
    },
    maxWeekendsPerPeriod: {
      label: 'Weekends per schedule',
      hint: 'The most weekends a nurse works in one schedule. Leave blank for no limit.',
      why: 'For contracts that cap weekends per schedule, such as "no more than 3 in six weeks".',
      optional: true,
      min: 0,
    },
    maxWeekendsPer4Weeks: {
      label: 'Weekends in any four weeks',
      hint:
        'The most weekends a nurse works in any four in a row, counted across schedules. ' +
        'Leave blank for no limit.',
      why:
        'For "two weekends off in four" contracts such as the VA–NNU Master Agreement (Art. 13). ' +
        'Unlike the per-schedule limit, it reads the same whatever length your schedules are.',
      optional: true,
      min: 0,
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const nurse of schedule.nursesById.values()) {
      if (!judgesWeekends(nurse)) continue;
      const weekends = nurseWeekends(schedule, nurse.id, ctx);
      if (weekends.inPeriod.size === 0) continue;
      const { runs, excess, windows } = weekendBreaches(weekends, params);
      // The shifts a weekend's breach names: the nurse's in-period shifts on that weekend.
      const shiftsOn = (weekend: IsoDate) =>
        schedule
          .timelineFor(nurse.id)
          .filter(
            (v) =>
              v.inPeriod && isWorked(v) && weekendKey(v.window, ctx.weekendDefinition) === weekend,
          );
      for (const { weekend, length } of runs) {
        const shifts = shiftsOn(weekend);
        violations.push(
          violation(
            weekendPatternRule,
            'soft',
            'excess_weekends',
            `${nurseName(nurse)} works ${length} weekends in a row, to the weekend of ` +
              `${describeDate(weekend)}; the contract allows ${params.maxConsecutiveWeekends}.`,
            {
              nurseIds: [nurse.id],
              dates: shifts.map((v) => v.assignment.date),
              assignmentIds: shifts.map((v) => v.assignment.id),
              details: { weekend, consecutive: length },
            },
          ),
        );
      }
      for (const { weekend, worked, excess: over } of windows) {
        const shifts = [3, 2, 1, 0].flatMap((back) => shiftsOn(addDays(weekend, -7 * back)));
        violations.push(
          violation(
            weekendPatternRule,
            'soft',
            'excess_weekends',
            `${nurseName(nurse)} works ${worked} of the 4 weekends to the weekend of ` +
              `${describeDate(weekend)}; the contract allows ${params.maxWeekendsPer4Weeks}.`,
            {
              nurseIds: [nurse.id],
              dates: shifts.map((v) => v.assignment.date),
              assignmentIds: shifts.map((v) => v.assignment.id),
              details: { weekend, workedIn4Weeks: worked, excess: over },
            },
          ),
        );
      }
      if (excess > 0) {
        const shifts = [...weekends.inPeriod].sort(compareDates).flatMap(shiftsOn);
        violations.push(
          violation(
            weekendPatternRule,
            'soft',
            'excess_weekends',
            `${nurseName(nurse)} works ${weekends.inPeriod.size} weekends in this schedule, ` +
              `${excess} more than the ${params.maxWeekendsPerPeriod} the contract allows.`,
            {
              nurseIds: [nurse.id],
              dates: shifts.map((v) => v.assignment.date),
              assignmentIds: shifts.map((v) => v.assignment.id),
              details: { weekends: weekends.inPeriod.size, excess },
            },
          ),
        );
      }
    }
    return violations;
  },
};
