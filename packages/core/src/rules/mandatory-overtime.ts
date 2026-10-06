/**
 * No mandatory overtime: an overtime shift must be one the nurse offered to work.
 *
 * New York (Labor Law § 167), Washington (RCW 49.28.140), Oregon (ORS 441.166) and
 * Massachusetts (c.111 § 226) forbid requiring a nurse to work overtime outside an emergency; a
 * nurse may still volunteer. The app already makes overtime explicit — a shift past the
 * threshold must be flagged authorised (`isOvertime`), or the max-hours rule refuses it — but
 * "authorised" said nothing about whether the nurse agreed. Without this rule a backfill could
 * hand an exhausted nurse a mandated double, and the schedule would read as compliant.
 *
 * So, where a unit's law or contract says so, an authorised-overtime shift needs either an
 * `OvertimeVolunteer` record covering its date or a stated emergency: notes beginning
 * "Emergency:" (each statute's exceptions are emergencies — a declared disaster, a patient-care
 * emergency after voluntary cover was tried). Off by default: most US units may mandate.
 *
 * Neither solver ever writes an overtime row, so Generate cannot breach it; it judges the
 * manager's and the day-of console's picks, and the console ranks unvolunteered overtime last.
 *
 * Federal VA nursing staff are under a different law: 38 U.S.C. § 7459(a) does not ban overtime,
 * it forbids *requiring* more than 40 hours in an administrative workweek (24 for nurses on the
 * § 7456 weekend plan). Voluntary hours (§ 7459(b)) and a non-recurring emergency once volunteers
 * are exhausted (§ 7459(c)) are outside it. `maxMandatedWeeklyHours` expresses that: an
 * unvolunteered, non-emergency overtime shift is allowed until the nurse's worked hours in its
 * work week pass the cap. Without it the rule is the total ban above.
 *
 * The statute also limits required *consecutive* hours (8, or 12 on compressed schedules). That
 * cannot be expressed here: a shift's hours are its shift type's length, and back-to-back shifts
 * already break the minimum-rest rule, so the weekly cap is the enforceable part.
 */

import type { Assignment, Id } from '../domain/entities.js';
import {
  addDays,
  compareDates,
  dateInRange,
  describeDate,
  type IsoDate,
  type Weekday,
  weekdayOf,
} from '../domain/time.js';
import type { Rule, RuleContext, Violation } from './types.js';
import { isWorked, nurseName, violation } from './types.js';

export interface MandatoryOvertimeParams {
  /** Whether notes beginning "Emergency:" excuse an overtime shift nobody volunteered for. */
  allowEmergencyNote: boolean;
  /**
   * The most hours a nurse may be required to work in a work week without agreeing. Absent: no
   * unvolunteered overtime at all.
   */
  maxMandatedWeeklyHours?: number;
  /** First day of the work week the cap is counted in. */
  workWeekStartsOn: Weekday;
}

/** The prefix a manager writes on a shift's notes to record an emergency. */
export const EMERGENCY_NOTE_PREFIX = 'Emergency:';

/** Whether the nurse has an offer to work overtime on a shift dated `date`. */
export function volunteeredOn(
  ctx: Pick<RuleContext, 'overtimeVolunteersByNurse'>,
  nurseId: Id,
  date: IsoDate,
): boolean {
  return (ctx.overtimeVolunteersByNurse.get(nurseId) ?? []).some((v) =>
    dateInRange(date, v.startDate, v.endDate),
  );
}

/** Whether a shift's notes record an emergency, the statutes' exception. */
export function isEmergency(assignment: Pick<Assignment, 'notes'>): boolean {
  return (assignment.notes ?? '')
    .trim()
    .toLowerCase()
    .startsWith(EMERGENCY_NOTE_PREFIX.toLowerCase());
}

export const mandatoryOvertimeRule: Rule<MandatoryOvertimeParams> = {
  id: 'no-mandatory-overtime',
  name: 'No mandatory overtime',
  description:
    'An overtime shift must be one the nurse volunteered for (Roster › Overtime volunteers), or ' +
    'an emergency recorded on the shift. For units under a ban on mandatory overtime, such as ' +
    'New York, Washington, Oregon and Massachusetts. With a weekly cap set, it instead allows ' +
    'required overtime up to that many hours in a work week, as 38 U.S.C. § 7459(a) does for VA ' +
    'nursing staff (40 hours; 24 on the weekend plan); volunteered hours and emergencies after ' +
    'volunteers are exhausted stay outside it.',
  severity: 'hard',
  category: 'hours',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { allowEmergencyNote: true, workWeekStartsOn: 0 },
  paramDocs: {
    allowEmergencyNote: {
      label: 'Allow an emergency recorded on the shift',
      hint: `An overtime shift whose notes begin "${EMERGENCY_NOTE_PREFIX}" is allowed without a volunteer.`,
      why:
        'Each ban has emergency exceptions — a declared disaster, a patient-care emergency after ' +
        'voluntary cover was tried. Turn this off if your contract allows none.',
    },
    maxMandatedWeeklyHours: {
      label: 'Most hours a nurse can be required to work in a week',
      hint: 'Leave blank to refuse all overtime the nurse did not volunteer for.',
      why:
        'Federal VA law (38 U.S.C. § 7459) caps required hours at 40 a week, 24 for nurses on the ' +
        'weekend plan, rather than banning them. Hours the nurse offered do not count against it.',
      optional: true,
      min: 1,
    },
    workWeekStartsOn: {
      label: 'Work week starts on',
      hint: 'The first day of the work week the required-hours cap is counted in.',
      why: 'Match the administrative workweek your agreement names; most start on Sunday.',
      input: 'weekday',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const view of schedule.assignments()) {
      const { assignment, nurse } = view;
      if (!assignment.isOvertime) continue;
      if (volunteeredOn(ctx, nurse.id, assignment.date)) continue;
      if (params.allowEmergencyNote && isEmergency(assignment)) continue;
      if (params.maxMandatedWeeklyHours !== undefined) {
        const weekStart = addDays(
          assignment.date,
          -((weekdayOf(assignment.date) - params.workWeekStartsOn + 7) % 7),
        );
        const weekEnd = addDays(weekStart, 6);
        let weekHours = 0;
        for (const v of schedule.timelineFor(nurse.id)) {
          const d = v.assignment.date;
          if (compareDates(d, weekStart) < 0 || compareDates(d, weekEnd) > 0) continue;
          if (isWorked(v)) weekHours += v.paidHours;
        }
        if (weekHours <= params.maxMandatedWeeklyHours) continue;
        violations.push(
          violation(
            mandatoryOvertimeRule,
            'hard',
            'mandatory_overtime',
            `${nurseName(nurse)} would be required to work ${weekHours}h in the week of ` +
              `${describeDate(weekStart)} on the ${view.shiftType.name} of ` +
              `${describeDate(assignment.date)}; no more than ${params.maxMandatedWeeklyHours}h ` +
              `may be required without their agreement. Record their offer under Roster › ` +
              `Overtime volunteers` +
              (params.allowEmergencyNote
                ? `, or the emergency on the shift's notes ("${EMERGENCY_NOTE_PREFIX} …").`
                : '.'),
            {
              dates: [assignment.date],
              nurseIds: [nurse.id],
              assignmentIds: [assignment.id],
              details: { weekHours, maxMandatedWeeklyHours: params.maxMandatedWeeklyHours },
            },
          ),
        );
        continue;
      }
      violations.push(
        violation(
          mandatoryOvertimeRule,
          'hard',
          'mandatory_overtime',
          `${nurseName(nurse)} is on overtime for the ${view.shiftType.name} on ` +
            `${describeDate(assignment.date)} without having volunteered for it. Record their offer ` +
            `under Roster › Overtime volunteers` +
            (params.allowEmergencyNote
              ? `, or the emergency on the shift's notes ("${EMERGENCY_NOTE_PREFIX} …").`
              : '.'),
          {
            dates: [assignment.date],
            nurseIds: [nurse.id],
            assignmentIds: [assignment.id],
          },
        ),
      );
    }
    return violations;
  },
};
