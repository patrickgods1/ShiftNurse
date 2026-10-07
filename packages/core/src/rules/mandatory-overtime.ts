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
 * The statute also limits required *consecutive* hours: "more than eight consecutive hours (or 12
 * hours if such staff is covered under section 7456 or 7456A)". A scheduled shift never breaks
 * that on its own (back-to-back shifts already break the minimum-rest rule), but a holdover does:
 * a nurse kept an hour past a 12-hour tour has worked 13 straight. So `Assignment.holdoverMinutes`
 * with `holdoverMandated` is a *required holdover*, judged by the stretch of continuous worked
 * time it sits in (`workedStretches`), against `maxRequiredConsecutiveHours` or, when a shift in
 * the stretch was scheduled longer than that (a compressed tour), `compressedTourConsecutiveHours`.
 * An `OvertimeVolunteer` offer does not excuse one: the holdover's own record says it was
 * required, and a holdover the nurse offered is recorded as volunteered, which this rule never
 * judges. An emergency note still does.
 *
 * Holdovers are recorded day-of on a published schedule, and only a draft is ever generated, so
 * Generate cannot breach this either.
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
import { type WorkedStretch, workedStretches } from '../schedule/holdover.js';
import type { AssignmentView } from '../schedule/view.js';
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
  /**
   * The most consecutive hours a nurse may be required to work. A required holdover whose
   * stretch of worked time passes it is a breach. Absent: no consecutive limit.
   */
  maxRequiredConsecutiveHours?: number;
  /**
   * The consecutive limit for a stretch containing a shift scheduled longer than
   * `maxRequiredConsecutiveHours` (a compressed tour). Absent: the base limit applies throughout.
   */
  compressedTourConsecutiveHours?: number;
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

/** "1h 30m", "45m", "2h": a holdover's length as a manager says it. */
function minutesText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : ''].filter(Boolean).join(' ');
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
    'volunteers are exhausted stay outside it. A required holdover (time kept past the end of ' +
    'the shift) is judged the same way, and a consecutive-hours limit (8, or 12 on a compressed ' +
    'tour) refuses a required holdover that runs a stretch past it.',
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
    maxRequiredConsecutiveHours: {
      label: 'Most consecutive hours a nurse can be required to work',
      hint: 'Leave blank for no consecutive-hours limit.',
      why:
        'Federal VA law (38 U.S.C. § 7459(a)) forbids requiring more than eight consecutive ' +
        'hours. It is what stops a required holdover from stretching a tour: held an hour past ' +
        'an 8-hour tour is nine hours straight. Hours the nurse offered do not count.',
      optional: true,
      min: 1,
    },
    compressedTourConsecutiveHours: {
      label: 'Most consecutive hours on a compressed tour',
      hint: 'Used instead when a shift in the stretch is scheduled longer than the limit above.',
      why:
        '38 U.S.C. § 7459(a) allows 12 for staff covered by § 7456 or § 7456A, the 12-hour ' +
        'tours. Without this, a 12-hour tour is over the 8-hour limit before anyone is held.',
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
    const weekly = params.maxMandatedWeeklyHours;
    const consecutive = params.maxRequiredConsecutiveHours;
    const stretchesByNurse = new Map<Id, WorkedStretch<AssignmentView>[]>();
    const reportedStretches = new Map<WorkedStretch<AssignmentView>, Violation>();
    const stretchesOf = (nurseId: Id) => {
      let found = stretchesByNurse.get(nurseId);
      if (!found) {
        found = workedStretches(schedule.timelineFor(nurseId));
        stretchesByNurse.set(nurseId, found);
      }
      return found;
    };
    for (const view of schedule.assignments()) {
      const { assignment, nurse } = view;
      const excused = params.allowEmergencyNote && isEmergency(assignment);
      const requiredOvertime =
        assignment.isOvertime && !volunteeredOn(ctx, nurse.id, assignment.date) && !excused;
      // The holdover's own record says it was required, so an overtime offer does not excuse it.
      const requiredHoldover =
        (assignment.holdoverMinutes ?? 0) > 0 && assignment.holdoverMandated === true && !excused;
      if (!requiredOvertime && !requiredHoldover) continue;

      if (weekly === undefined && consecutive === undefined) {
        if (requiredOvertime) {
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
        if (requiredHoldover) {
          violations.push(
            violation(
              mandatoryOvertimeRule,
              'hard',
              'mandatory_overtime',
              `${nurseName(nurse)} was required to stay ${minutesText(assignment.holdoverMinutes!)} ` +
                `past the end of the ${view.shiftType.name} on ${describeDate(assignment.date)} ` +
                `without having volunteered. Record it as volunteered if they offered` +
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
        continue;
      }

      if (weekly !== undefined) {
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
        if (weekHours > weekly) {
          violations.push(
            violation(
              mandatoryOvertimeRule,
              'hard',
              'mandatory_overtime',
              `${nurseName(nurse)} would be required to work ${weekHours}h in the week of ` +
                `${describeDate(weekStart)} on the ${view.shiftType.name} of ` +
                `${describeDate(assignment.date)}; no more than ${weekly}h ` +
                `may be required without their agreement. Record their offer under Roster › ` +
                `Overtime volunteers` +
                (params.allowEmergencyNote
                  ? `, or the emergency on the shift's notes ("${EMERGENCY_NOTE_PREFIX} …").`
                  : '.'),
              {
                dates: [assignment.date],
                nurseIds: [nurse.id],
                assignmentIds: [assignment.id],
                details: { weekHours, maxMandatedWeeklyHours: weekly },
              },
            ),
          );
        }
      }

      if (consecutive !== undefined) {
        const stretch = stretchesOf(nurse.id).find((st) =>
          st.views.some((v) => v.assignment.id === assignment.id),
        );
        if (!stretch) {
          // Standby is not worked time, so it is in no stretch; anything else must be.
          if (view.shiftType.isOnCall) continue;
          throw new Error(`Assignment ${assignment.id} is in no worked stretch of ${nurse.id}`);
        }
        const compressed =
          params.compressedTourConsecutiveHours !== undefined &&
          stretch.views.some((v) => v.scheduledHours > consecutive);
        const limit = compressed ? params.compressedTourConsecutiveHours! : consecutive;
        if (stretch.hours <= limit) continue;
        // One breach per stretch: a second required item in it joins the first one's report.
        const reported = reportedStretches.get(stretch);
        if (reported) {
          reported.assignmentIds!.push(assignment.id);
          continue;
        }
        const found = violation(
          mandatoryOvertimeRule,
          'hard',
          'mandatory_overtime',
          `${nurseName(nurse)} would be required to work ${stretch.hours}h straight through the ` +
            `${view.shiftType.name} of ${describeDate(assignment.date)}; no more than ${limit}h ` +
            `in a row may be required without their agreement. Record their offer under ` +
            `Roster › Overtime volunteers` +
            (params.allowEmergencyNote
              ? `, or the emergency on the shift's notes ("${EMERGENCY_NOTE_PREFIX} …").`
              : '.'),
          {
            dates: [assignment.date],
            nurseIds: [nurse.id],
            assignmentIds: [assignment.id],
            details: { stretchHours: stretch.hours, consecutiveLimit: limit },
          },
        );
        reportedStretches.set(stretch, found);
        violations.push(found);
      }
    }
    return violations;
  },
};
