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
 */

import type { Assignment, Id } from '../domain/entities.js';
import { dateInRange, describeDate, type IsoDate } from '../domain/time.js';
import type { Rule, RuleContext, Violation } from './types.js';
import { nurseName, violation } from './types.js';

export interface MandatoryOvertimeParams {
  /** Whether notes beginning "Emergency:" excuse an overtime shift nobody volunteered for. */
  allowEmergencyNote: boolean;
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
    'New York, Washington, Oregon and Massachusetts.',
  severity: 'hard',
  category: 'hours',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { allowEmergencyNote: true },
  paramDocs: {
    allowEmergencyNote: {
      label: 'Allow an emergency recorded on the shift',
      hint: `An overtime shift whose notes begin "${EMERGENCY_NOTE_PREFIX}" is allowed without a volunteer.`,
      why:
        'Each ban has emergency exceptions — a declared disaster, a patient-care emergency after ' +
        'voluntary cover was tried. Turn this off if your contract allows none.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const view of schedule.assignments()) {
      const { assignment, nurse } = view;
      if (!assignment.isOvertime) continue;
      if (volunteeredOn(ctx, nurse.id, assignment.date)) continue;
      if (params.allowEmergencyNote && isEmergency(assignment)) continue;
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
