/**
 * No mandatory overtime: an overtime shift must be one the nurse offered to work.
 *
 * New York (Labor Law § 167), Washington (RCW 49.28.140), Oregon (ORS 441.770) and
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
 * work week pass the cap. Without it the rule is the total ban above. `baylorMaxMandatedWeeklyHours`
 * is the 24 for a nurse whose `scheduleKind` is the weekend plan; unset, they share the weekly cap.
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
 * Some states ban mandatory overtime except in an emergency yet cap even an emergency mandate:
 * Illinois (210 ILCS 85/10.9) says it "shall not exceed 4 hours beyond an agreed-to, predetermined
 * work shift"; Rhode Island (R.I. Gen. Laws § 23-17.20-3(b)) says "in no case" more than twelve
 * consecutive hours. Without `emergencyMaxHoursPastShift` / `emergencyMaxConsecutiveHours` an
 * "Emergency:" note excused a required holdover completely, so those caps could not be written.
 * They judge a required holdover whether or not it is an emergency, and never a volunteered one.
 *
 * California's Wage Order 5 § 3(B)(9)–(11) counts differently: a nurse on a 12-hour alternative
 * workweek may not be *required* to work more than 12 hours "in any 24 hour period", a declared
 * health-care emergency lifts that but "no employee shall be required to work more than 16 hours
 * in a 24-hour period", and a relief nurse's late no-show allows 13. A consecutive limit misses
 * a 12-hour day, 8 hours off and 4 required hours in the same 24, so `maxRequiredHoursIn24` and
 * `emergencyMaxHoursIn24` judge the busiest 24 hours holding the required item, counting every
 * worked hour in them (hours the nurse offered too: the Order limits what may be required,
 * measured over everything worked). As in `max-hours-in-24`, the hours in `[t, t + 1440)` peak at
 * some shift's start or some shift's end − 1440, so those anchors are checked exactly. The
 * in-24 emergency cap also judges an unvolunteered overtime *shift*: a required extra shift is
 * what (B)(10) is about.
 *
 * Holdovers are recorded day-of on a published schedule, and only a draft is ever generated, so
 * Generate cannot breach this either.
 */

import { isBaylorPlan } from '../cost/cost.js';
import type { Assignment, Id, Nurse } from '../domain/entities.js';
import {
  addDays,
  compareDates,
  dateInRange,
  describeDate,
  type IsoDate,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  type ShiftWindow,
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
   * The weekly cap for a nurse on the § 7456 Baylor weekend plan. Absent: `maxMandatedWeeklyHours`
   * applies to them too.
   */
  baylorMaxMandatedWeeklyHours?: number;
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
  /**
   * The most hours a required holdover may run past the shift's end, emergency or not.
   * Absent: no limit.
   */
  emergencyMaxHoursPastShift?: number;
  /**
   * The most consecutive hours a required holdover's stretch may reach, emergency or not.
   * Absent: no limit.
   */
  emergencyMaxConsecutiveHours?: number;
  /**
   * The most hours a nurse may be required to work in any 24-hour period. A required holdover or
   * an unvolunteered overtime shift whose hours make some 24-hour window hold more is a breach;
   * hours the nurse offered still count toward the window (the Order limits what may be
   * required, measured over everything worked). Absent: no limit.
   */
  maxRequiredHoursIn24?: number;
  /**
   * The most hours in any 24-hour period a required holdover or unvolunteered overtime shift may
   * reach, emergency or not (Wage Order 5 § 3(B)(10): 16). Absent: no limit.
   */
  emergencyMaxHoursIn24?: number;
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

/** The busiest 24 hours that hold some of `required`, and the worked shifts in them. */
interface Peak {
  hours: number;
  views: AssignmentView[];
}

/**
 * The most hours worked in a window `[t, t + 1440)` overlapping `required`. Over all t the sum
 * peaks at a shift's start or a shift's end − 1440; the windows that just graze `required` at
 * either edge hold no more than the ones anchored at its start or at the shift's end − 1440, so
 * checking the anchors that overlap it (plus `required`'s own start, which a holdover's is not)
 * finds the true peak. Both edges of that domain are evaluated too — the first window to reach
 * `required` (starting 1439 minutes before it) and the last (starting a minute before it ends) —
 * so the result does not rest on that slope argument holding for every timeline.
 * `worked` must be sorted by start.
 */
function peakIn24(worked: readonly AssignmentView[], required: ShiftWindow): Peak {
  const anchors = new Set<number>([
    required.startMinute,
    required.startMinute - MINUTES_PER_DAY + 1,
    required.endMinute - 1,
  ]);
  for (const v of worked) {
    anchors.add(v.window.startMinute);
    anchors.add(v.window.endMinute - MINUTES_PER_DAY);
  }
  let best: Peak = { hours: 0, views: [] };
  for (const from of [...anchors].sort((a, b) => a - b)) {
    const to = from + MINUTES_PER_DAY;
    if (from >= required.endMinute || to <= required.startMinute) continue;
    let minutes = 0;
    const views: AssignmentView[] = [];
    for (const v of worked) {
      if (v.window.startMinute >= to) break;
      const m = Math.max(
        0,
        Math.min(v.window.endMinute, to) - Math.max(v.window.startMinute, from),
      );
      if (m === 0) continue;
      minutes += m;
      views.push(v);
    }
    if (minutes / MINUTES_PER_HOUR > best.hours)
      best = { hours: minutes / MINUTES_PER_HOUR, views };
  }
  return best;
}

/**
 * The part of a shift that was required: all of it for an overtime shift nobody volunteered for,
 * only the time past the scheduled end for a required holdover on an ordinary shift.
 */
function requiredWindow(view: AssignmentView, wholeShift: boolean): ShiftWindow {
  if (wholeShift) return view.window;
  return {
    startMinute: view.window.endMinute - (view.assignment.holdoverMinutes ?? 0),
    endMinute: view.window.endMinute,
  };
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
    'tour) refuses a required holdover that runs a stretch past it. A limit on required hours in ' +
    'any 24 (California’s 12-hour alternative workweek: 12) counts every hour worked in the ' +
    'busiest 24 holding the required time. Further limits hold even when the shift records an ' +
    'emergency: how long a required holdover may run past the shift (Illinois: 4 hours), how many ' +
    'hours in a row it may reach (Rhode Island: 12) and how many in any 24 a required holdover or ' +
    'overtime shift may reach (California: 16).',
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
    baylorMaxMandatedWeeklyHours: {
      label: 'Required hours a week on the Baylor plan',
      hint: 'The weekly cap for nurses on the § 7456 weekend plan; 24 at the VA.',
      why:
        '38 U.S.C. § 7459(a) caps the hours a nurse can be required to work at 40 a week, but at ' +
        '24 for a nurse on the § 7456 weekend plan. Leave blank to use the weekly cap above for ' +
        'them too.',
      optional: true,
      min: 0,
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
    emergencyMaxHoursPastShift: {
      label: 'Most hours a required holdover can run past the shift, even in an emergency',
      hint: 'Leave blank for no limit on an emergency holdover.',
      why:
        'Illinois (210 ILCS 85/10.9) allows mandated overtime in an emergency but says it "shall ' +
        'not exceed 4 hours beyond an agreed-to, predetermined work shift". A note beginning ' +
        '"Emergency:" does not excuse a holdover past this.',
      optional: true,
      min: 1,
    },
    emergencyMaxConsecutiveHours: {
      label: 'Most consecutive hours a required holdover can reach, even in an emergency',
      hint: 'Leave blank for no limit on an emergency holdover.',
      why:
        'Rhode Island (R.I. Gen. Laws § 23-17.20-3(b)): "In no case shall a health care facility ' +
        'require an employee to work in excess of twelve (12) consecutive hours." A note ' +
        'beginning "Emergency:" does not excuse a holdover that makes the stretch longer.',
      optional: true,
      min: 1,
    },
    maxRequiredHoursIn24: {
      label: 'Most hours a nurse can be required to work in any 24',
      hint:
        'Counts every hour worked in the busiest 24 hours holding the required time. Leave blank ' +
        'for no limit.',
      why:
        'California Wage Order 5 § 3(B)(9): no employee on a 12-hour shift "shall be required to ' +
        'work more than 12 hours in any 24 hour period" unless a health-care emergency is ' +
        'declared. A 12-hour day, 8 hours off and 4 required hours is 16 in 24 though never more ' +
        'than 12 in a row. Hours the nurse offered still count toward the 24.',
      optional: true,
      min: 1,
    },
    emergencyMaxHoursIn24: {
      label: 'Most hours in any 24 a nurse can be required to reach, even in an emergency',
      hint: 'Leave blank for no limit on emergency hours in 24.',
      why:
        'California Wage Order 5 § 3(B)(10): "no employee shall be required to work more than 16 ' +
        'hours in a 24-hour period unless by voluntary mutual agreement of the employee and ' +
        'employer". A note beginning "Emergency:" does not excuse a required holdover or ' +
        'overtime shift past this.',
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
    const weeklyFor = (nurse: Nurse) =>
      isBaylorPlan(nurse)
        ? (params.baylorMaxMandatedWeeklyHours ?? params.maxMandatedWeeklyHours)
        : params.maxMandatedWeeklyHours;
    const consecutive = params.maxRequiredConsecutiveHours;
    const in24 = params.maxRequiredHoursIn24;
    const workedByNurse = new Map<Id, AssignmentView[]>();
    const workedOf = (nurseId: Id) => {
      let found = workedByNurse.get(nurseId);
      if (!found) {
        found = schedule.timelineFor(nurseId).filter(isWorked);
        workedByNurse.set(nurseId, found);
      }
      return found;
    };
    // One breach per nurse per busiest window, keyed on the shifts in it, across both passes.
    const reportedWindows = new Map<string, Violation>();
    const windowKey = (nurseId: Id, peak: Peak) =>
      `${nurseId}|${peak.views
        .map((v) => v.assignment.id)
        .sort()
        .join('|')}`;
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
      const weekly = weeklyFor(nurse);

      if (weekly === undefined && consecutive === undefined && in24 === undefined) {
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

      if (in24 !== undefined && isWorked(view)) {
        const peak = peakIn24(workedOf(nurse.id), requiredWindow(view, requiredOvertime));
        if (peak.hours > in24) {
          const key = windowKey(nurse.id, peak);
          const reported = reportedWindows.get(key);
          if (reported) {
            reported.assignmentIds!.push(assignment.id);
          } else {
            const found = violation(
              mandatoryOvertimeRule,
              'hard',
              'mandatory_overtime',
              `${nurseName(nurse)} would be required to work ${peak.hours}h within 24 hours of ` +
                `the ${view.shiftType.name} on ${describeDate(assignment.date)}; no more than ` +
                `${in24}h in any 24 may be required without their agreement. Record their offer ` +
                `under Roster › Overtime volunteers` +
                (params.allowEmergencyNote
                  ? `, or the emergency on the shift's notes ("${EMERGENCY_NOTE_PREFIX} …").`
                  : '.'),
              {
                dates: [assignment.date],
                nurseIds: [nurse.id],
                assignmentIds: [assignment.id],
                details: { hoursIn24: peak.hours, maxRequiredHoursIn24: in24 },
              },
            );
            reportedWindows.set(key, found);
            violations.push(found);
          }
        }
      }
    }

    // Limits that hold even in an emergency. A second pass, because the loop above skips an
    // excused holdover entirely and a required one it already reported must not be reported twice.
    const maxPast = params.emergencyMaxHoursPastShift;
    const maxStretch = params.emergencyMaxConsecutiveHours;
    const maxIn24 = params.emergencyMaxHoursIn24;
    if (maxPast !== undefined || maxStretch !== undefined || maxIn24 !== undefined) {
      const flagged = new Set(violations.flatMap((v) => v.assignmentIds ?? []));
      const reportedEmergencyStretches = new Set<WorkedStretch<AssignmentView>>();
      for (const view of schedule.assignments()) {
        const { assignment, nurse } = view;
        const minutes = assignment.holdoverMinutes ?? 0;
        const heldOver = minutes > 0 && assignment.holdoverMandated === true;
        const unvolunteered =
          assignment.isOvertime && !volunteeredOn(ctx, nurse.id, assignment.date);
        if (!heldOver && !unvolunteered) continue;
        if (flagged.has(assignment.id)) continue;
        const where = `the ${view.shiftType.name} on ${describeDate(assignment.date)}`;
        const refs = {
          dates: [assignment.date],
          nurseIds: [nurse.id],
          assignmentIds: [assignment.id],
        };
        if (heldOver && maxPast !== undefined && minutes / 60 > maxPast) {
          violations.push(
            violation(
              mandatoryOvertimeRule,
              'hard',
              'mandatory_overtime',
              `${nurseName(nurse)} was required to stay ${minutesText(minutes)} past the end of ` +
                `${where}; even in an emergency, no more than ${maxPast}h past a shift may be ` +
                `required.`,
              {
                ...refs,
                details: { hoursPastShift: minutes / 60, emergencyMaxHoursPastShift: maxPast },
              },
            ),
          );
          flagged.add(assignment.id);
          continue;
        }
        if (heldOver && maxStretch !== undefined) {
          const stretch = stretchesOf(nurse.id).find((st) =>
            st.views.some((v) => v.assignment.id === assignment.id),
          );
          if (!stretch) {
            if (view.shiftType.isOnCall) continue;
            throw new Error(`Assignment ${assignment.id} is in no worked stretch of ${nurse.id}`);
          }
          if (stretch.hours > maxStretch) {
            // One breach per stretch, and none for one the checks above already reported.
            if (reportedStretches.has(stretch) || reportedEmergencyStretches.has(stretch)) continue;
            reportedEmergencyStretches.add(stretch);
            violations.push(
              violation(
                mandatoryOvertimeRule,
                'hard',
                'mandatory_overtime',
                `${nurseName(nurse)} was required to stay ${minutesText(minutes)} past the end of ` +
                  `${where}, making ${stretch.hours}h straight; even in an emergency, no more ` +
                  `than ${maxStretch}h in a row may be required.`,
                {
                  ...refs,
                  details: {
                    stretchHours: stretch.hours,
                    emergencyMaxConsecutiveHours: maxStretch,
                  },
                },
              ),
            );
            continue;
          }
        }
        if (maxIn24 === undefined || !isWorked(view)) continue;
        const peak = peakIn24(workedOf(nurse.id), requiredWindow(view, unvolunteered));
        if (peak.hours <= maxIn24) continue;
        const key = windowKey(nurse.id, peak);
        const reported = reportedWindows.get(key);
        if (reported) {
          reported.assignmentIds!.push(assignment.id);
          continue;
        }
        const found = violation(
          mandatoryOvertimeRule,
          'hard',
          'mandatory_overtime',
          `${nurseName(nurse)} would be required to work ${peak.hours}h within 24 hours of ` +
            `${where}; even in an emergency, no more than ${maxIn24}h in any 24 may be required ` +
            `without their agreement.`,
          { ...refs, details: { hoursIn24: peak.hours, emergencyMaxHoursIn24: maxIn24 } },
        );
        reportedWindows.set(key, found);
        violations.push(found);
      }
    }
    return violations;
  },
};
