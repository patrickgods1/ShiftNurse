/**
 * A nurse on a VA compressed plan works the plan's tours, and anything else is overtime.
 *
 * 38 U.S.C. § 7456A schedules a 72/80 nurse six 12-hour tours in 14 days, and § 7456 schedules a
 * Baylor nurse two 12-hour tours between midnight Friday and midnight Sunday. The plan is what the
 * nurse is paid and credited on, so an 8 for a 72/80 nurse or a Wednesday for a Baylor nurse is
 * not a tour of the plan at all — yet neither solver would know, because to them a shift is a
 * shift. Without this rule Generate fills a Baylor nurse's weekdays.
 *
 * A shift off the plan is allowed when it is recorded as overtime: § 7456A(c)(1)(C) prices a
 * call-in on a non-tour day as overtime, and a manager can still record one. Neither solver
 * writes an overtime row, so Generate keeps every plan nurse on their tours.
 *
 * "A Baylor tour" is `isBaylorTour` (`cost/cost.ts`), the one definition shared with pricing:
 * a 12-hour shift dated Saturday or Sunday, or a Friday one whose window crosses midnight into
 * the weekend. Standby is not a tour, so it is not judged; the lookback tail is never flagged.
 *
 * Hard, on by default and silent for a nurse with no plan. Monotone under removal (taking a
 * shift away cannot put another off the plan), so the gate is the generic nurse-scope one;
 * `encodeScheduleKindTours` fixes every off-plan variable to 0 for CP-SAT.
 */

import { isBaylorPlan, isBaylorTour } from '../cost/cost.js';
import type { Nurse } from '../domain/entities.js';
import { describeDate } from '../domain/time.js';
import type { AssignmentView } from '../schedule/view.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

export type ScheduleKindToursParams = Record<string, never>;

/**
 * Whether a shift is off the nurse's plan, before overtime is considered. Shared with the
 * CP-SAT encoder, which judges a candidate shift by the same test.
 */
export function offPlanTour(view: AssignmentView): boolean {
  if (view.nurse.scheduleKind === 'va_72_80') return view.scheduledHours !== 12;
  if (isBaylorPlan(view.nurse)) return !isBaylorTour(view);
  return false;
}

function planText(nurse: Nurse, view: AssignmentView): string {
  const where = `the ${view.shiftType.name} on ${describeDate(view.assignment.date)}`;
  return nurse.scheduleKind === 'va_72_80'
    ? `${nurseName(nurse)} is on the 72/80 plan (38 U.S.C. § 7456A) and ${where} is not a ` +
        '12-hour tour. Mark it overtime if it is an extra day, or move it.'
    : `${nurseName(nurse)} is on the Baylor weekend plan (38 U.S.C. § 7456) and ${where} is not ` +
        'a 12-hour tour between Friday night and Sunday. Mark it overtime if it is an extra ' +
        'shift, or move it.';
}

export const scheduleKindToursRule: Rule<ScheduleKindToursParams> = {
  id: 'schedule-kind-tours',
  name: 'Tours on the nurse’s plan',
  description:
    'A nurse on the VA 72/80 plan works 12-hour tours, and a nurse on the Baylor weekend plan ' +
    'works 12-hour tours from Friday night to Sunday. Any other shift must be recorded as ' +
    'overtime. Nurses on a standard schedule are not judged.',
  severity: 'hard',
  category: 'rest',
  scope: 'nurse',
  enabledByDefault: true,
  defaultParams: {},
  paramDocs: {},

  evaluate(schedule, _params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const nurse of ctx.nurses) {
      if (nurse.scheduleKind !== 'va_72_80' && !isBaylorPlan(nurse)) continue;
      for (const view of schedule.timelineFor(nurse.id)) {
        if (!view.inPeriod || !isWorked(view) || view.assignment.isOvertime) continue;
        if (!offPlanTour(view)) continue;
        violations.push(
          violation(scheduleKindToursRule, 'hard', 'off_plan_tour', planText(nurse, view), {
            nurseIds: [nurse.id],
            dates: [view.assignment.date],
            assignmentIds: [view.assignment.id],
            details: { scheduleKind: nurse.scheduleKind, scheduledHours: view.scheduledHours },
          }),
        );
      }
    }
    return violations;
  },
};
