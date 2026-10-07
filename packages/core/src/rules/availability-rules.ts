/**
 * Availability rules — the two things that must never happen.
 *
 * Both of these are the kind of error that destroys trust in a schedule instantly. A nurse
 * who finds themselves rostered during approved vacation stops believing the system, and so
 * does everyone they tell.
 */

import type { Id, TimeOffRequest } from '../domain/entities.js';
import {
  addDays,
  crossesMidnight,
  dateInRange,
  describeDate,
  describeDateRange,
  type IsoDate,
  type ShiftTiming,
  windowsOverlap,
} from '../domain/time.js';
import type { ScheduleView } from '../schedule/view.js';
import { nurseName, type Rule, type RuleContext, type Violation, violation } from './types.js';

// ---------------------------------------------------------------------------
// Approved time off is absolute
// ---------------------------------------------------------------------------

export interface TimeOffParams {
  /**
   * Whether a shift that starts the day before approved leave and runs past midnight into its
   * first morning counts as working during it.
   *
   * Off by default: leave is booked against the shifts dated in it, and a shift is dated by the
   * day it starts, so a nurse off on Saturday may work Friday night and finish at 07:00 — if
   * they want Friday night off too, they request Friday. The minimum-rest rule already protects
   * the turnaround. Some contracts define a day off as a whole calendar day free of work; they
   * turn this on. It is judged by when the shift actually ends, not by its night flag: an
   * evening tour flagged as an off-tour for its differential still ends before midnight.
   */
  nightShiftEndingOnLeaveCounts: boolean;
}

export const timeOffRule: Rule<TimeOffParams> = {
  id: 'approved-time-off-is-absolute',
  name: 'Approved time off is absolute',
  description:
    'Once time off is approved, the nurse cannot be scheduled during it. Changing this requires ' +
    'revoking the approval explicitly, which is logged.',
  severity: 'hard',
  category: 'coverage',
  scope: 'nurse',
  defaultParams: { nightShiftEndingOnLeaveCounts: false },
  paramDocs: {
    nightShiftEndingOnLeaveCounts: {
      label: 'Leave covers the night before',
      hint: 'A shift that ends on the first morning of leave counts as working during it.',
      why:
        'Off by default: leave on Saturday removes the shifts that start on Saturday, so the ' +
        'nurse may still work Friday night and finish Saturday at 07:00. Turn it on if your ' +
        'contract makes a day off a whole calendar day free of work.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const view of schedule.assignments()) {
      const approved = ctx.approvedTimeOffByNurse.get(view.nurse.id);
      if (!approved || approved.length === 0) continue;

      for (const request of approved) {
        const conflictDate = overlappingLeaveDate(
          view.assignment.date,
          view.shiftType,
          request,
          params,
        );
        if (!conflictDate) continue;

        violations.push(
          violation(
            timeOffRule,
            'hard',
            'works_during_approved_time_off',
            `${nurseName(view.nurse)} is scheduled for the ${view.shiftType.name} on ` +
              `${describeDate(view.assignment.date)} during approved ${describeType(request)} ` +
              `(${describeDateRange(request.startDate, request.endDate)}).`,
            {
              nurseIds: [view.nurse.id],
              dates: [view.assignment.date],
              assignmentIds: [view.assignment.id],
              details: {
                timeOffRequestId: request.id,
                timeOffType: request.type,
                leaveStart: request.startDate,
                leaveEnd: request.endDate,
              },
            },
          ),
        );
        break; // One violation per assignment is enough.
      }
    }

    return violations;
  },
};

/**
 * The leave date a shift on `date` would fall on, if any. Exported so the CP-SAT encoder decides
 * "no variable here" with the rule's own logic, night-before-leave included.
 */
export function overlappingLeaveDate(
  date: IsoDate,
  shiftType: ShiftTiming,
  request: TimeOffRequest,
  params: TimeOffParams,
): IsoDate | null {
  if (dateInRange(date, request.startDate, request.endDate)) return date;
  if (params.nightShiftEndingOnLeaveCounts && crossesMidnight(shiftType)) {
    // The shift starts the day before leave begins but runs into its first morning.
    const endsOn = nextDay(date);
    if (dateInRange(endsOn, request.startDate, request.endDate)) return endsOn;
  }
  return null;
}

function nextDay(date: IsoDate): IsoDate {
  return addDays(date, 1);
}

export function describeType(request: Pick<TimeOffRequest, 'type'>): string {
  switch (request.type) {
    case 'pto':
      return 'PTO';
    case 'sick':
      return 'sick leave';
    case 'fmla':
      return 'FMLA leave';
    case 'unpaid':
      return 'unpaid leave';
    case 'education':
      return 'education leave';
    case 'bereavement':
      return 'bereavement leave';
    case 'annual':
      return 'annual leave';
    case 'court':
      return 'court leave';
    case 'military':
      return 'military leave';
    case 'parental':
      return 'paid parental leave';
    case 'lwop':
      return 'leave without pay';
    case 'comp':
      return 'comp time';
    case 'state_family':
      return 'state family leave';
  }
}

// ---------------------------------------------------------------------------
// No overlapping assignments
// ---------------------------------------------------------------------------

export interface OverlapParams {
  /**
   * Whether standby may overlap a worked shift. It cannot: a nurse already at the bedside
   * is not available to be called in.
   */
  allowOnCallDuringShift: boolean;
}

export const overlapRule: Rule<OverlapParams> = {
  id: 'no-overlapping-assignments',
  name: 'No overlapping assignments',
  description:
    'A nurse cannot be in two places at once, including standby overlapping a worked shift.',
  severity: 'hard',
  category: 'coverage',
  scope: 'nurse',
  defaultParams: { allowOnCallDuringShift: false },
  paramDocs: {
    allowOnCallDuringShift: {
      label: 'Allow on-call during a shift',
      hint: 'Whether a nurse may be on standby while also working a shift.',
      why:
        'Leave this off: a nurse at the bedside cannot also be called in. Turn it on only if ' +
        'your on-call is a separate role that someone working can hold.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const nurse of ctx.nurses) {
      const timeline = schedule.timelineFor(nurse.id);
      for (let i = 1; i < timeline.length; i++) {
        const previous = timeline[i - 1];
        const current = timeline[i];
        if (!previous || !current) continue;
        if (!previous.inPeriod && !current.inPeriod) continue;
        if (!windowsOverlap(previous.window, current.window)) continue;
        if (
          params.allowOnCallDuringShift &&
          (previous.shiftType.isOnCall || current.shiftType.isOnCall)
        ) {
          continue;
        }

        violations.push(
          violation(
            overlapRule,
            'hard',
            'overlapping_assignments',
            `${nurseName(nurse)} is double-booked: the ${previous.shiftType.name} on ` +
              `${describeDate(previous.assignment.date)} overlaps the ${current.shiftType.name} on ` +
              `${describeDate(current.assignment.date)}.`,
            {
              nurseIds: [nurse.id],
              dates: [previous.assignment.date, current.assignment.date],
              assignmentIds: [previous.assignment.id, current.assignment.id],
            },
          ),
        );
      }
    }

    return violations;
  },
};

/** Approved leave covering a date, if any. Used by the solver and the replacement finder. */
export function approvedLeaveOn(
  ctx: RuleContext,
  nurseId: Id,
  date: IsoDate,
): TimeOffRequest | undefined {
  const approved = ctx.approvedTimeOffByNurse.get(nurseId);
  if (!approved) return undefined;
  return approved.find((r) => dateInRange(date, r.startDate, r.endDate));
}

/** True when the nurse already has a shift overlapping this window. */
export function hasOverlap(
  schedule: ScheduleView,
  nurseId: Id,
  window: { startMinute: number; endMinute: number },
): boolean {
  return schedule.timelineFor(nurseId).some((v) => windowsOverlap(v.window, window));
}
