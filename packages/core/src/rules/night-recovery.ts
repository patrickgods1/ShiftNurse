/**
 * Days off after nights: a nurse coming off a night shift gets time to turn their sleep back
 * around before a day or evening shift.
 *
 * The rest rule only measures hours between shifts, and a night ending at 07:00 Tuesday followed
 * by a day shift at 07:00 Wednesday has a full 24 hours. That is legal and it is exactly the
 * flip nurses complain about most: a body still on nights asked to be sharp at 07:00. Units
 * write it as "48 hours off after nights before returning to days". Without this rule the solver
 * scatters single nights between day shifts — Night, Day, Night inside four days — whenever that
 * balances the night count, and nothing on the grid says anything is wrong.
 *
 * Advisory by default. One finding per day-side shift (not per night), against the last night
 * before it, so a stretch of three nights followed too soon by a day reads as one problem.
 * The lookback tail counts: a night at the end of the last schedule still needs its days off.
 * The solver prices it per day-side shift the same way (`SolverModel`, `nightRecoveryTerms`).
 */

import { dayNumber, describeDate } from '../domain/time.js';
import type { AssignmentView } from '../schedule/view.js';
import type { Rule, Violation } from './types.js';
import { isWorked, nurseName, violation } from './types.js';

export interface NightRecoveryParams {
  /** Whole days a nurse is off after a night before a day or evening shift. */
  daysOffAfterNights: number;
}

/** A worked shift that is not a night: day, evening, mid. */
export function isDaySide(view: Pick<AssignmentView, 'shiftType'>): boolean {
  return !view.shiftType.isOnCall && !view.shiftType.isNight;
}

/** A worked night shift. */
export function isWorkedNight(view: Pick<AssignmentView, 'shiftType'>): boolean {
  return !view.shiftType.isOnCall && view.shiftType.isNight;
}

/**
 * Whether a day-side shift starting `daySide` days after a night shift dated `night` comes too
 * soon: the days strictly between them are the days off, so with 2 required, a night on Monday
 * allows a day shift from Thursday.
 */
export function tooSoonAfterNight(nightDay: number, daySideDay: number, required: number): boolean {
  const gap = daySideDay - nightDay;
  return gap >= 1 && gap <= required;
}

export const nightRecoveryRule: Rule<NightRecoveryParams> = {
  id: 'recovery-after-nights',
  name: 'Days off after nights',
  description:
    'After a night shift, a nurse gets whole days off before a day or evening shift, so their ' +
    'sleep can turn back around. Advisory: Generate avoids the quick flip from nights to days, ' +
    'and the grid flags it.',
  severity: 'soft',
  category: 'rest',
  scope: 'nurse',
  defaultParams: { daysOffAfterNights: 2 },
  paramDocs: {
    daysOffAfterNights: {
      label: 'Days off after nights',
      hint: 'Whole days off after a night shift before a day or evening shift.',
      why:
        'Two days (48 hours) is the common standard: off nights Tuesday morning, back on days ' +
        'Thursday. Set 1 if your unit rotates faster, or 3 for longer night stretches.',
      min: 1,
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    const required = Math.max(0, Math.floor(params.daysOffAfterNights));
    if (required === 0) return violations;

    for (const nurse of ctx.nurses) {
      const timeline = schedule.timelineFor(nurse.id).filter(isWorked);
      const nights = timeline.filter(isWorkedNight).map((v) => ({
        view: v,
        day: dayNumber(v.assignment.date),
      }));
      if (nights.length === 0) continue;

      for (const view of timeline) {
        if (!view.inPeriod || !isDaySide(view)) continue;
        const day = dayNumber(view.assignment.date);
        let last: (typeof nights)[number] | undefined;
        for (const night of nights) {
          if (!tooSoonAfterNight(night.day, day, required)) continue;
          if (!last || night.day > last.day) last = night;
        }
        if (!last) continue;
        const daysOff = day - last.day - 1;
        violations.push(
          violation(
            nightRecoveryRule,
            'soft',
            'short_recovery_after_nights',
            `${nurseName(nurse)} works the ${view.shiftType.name} on ` +
              `${describeDate(view.assignment.date)} with only ${daysOff} day${daysOff === 1 ? '' : 's'} ` +
              `off after nights (${last.view.shiftType.name} on ` +
              `${describeDate(last.view.assignment.date)}); ${required} are recommended.`,
            {
              nurseIds: [nurse.id],
              dates: [view.assignment.date],
              assignmentIds: [view.assignment.id, last.view.assignment.id],
              details: { daysOff, required, nightDate: last.view.assignment.date },
            },
          ),
        );
      }
    }
    return violations;
  },
};
