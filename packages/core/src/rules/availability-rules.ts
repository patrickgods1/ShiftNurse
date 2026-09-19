/**
 * Availability rules — the two things that must never happen.
 *
 * Both of these are the kind of error that destroys trust in a schedule instantly. A nurse
 * who finds themselves rostered during approved vacation stops believing the system, and so
 * does everyone they tell.
 */

import type { Id, TimeOffRequest } from '../domain/entities.js';
import { dateInRange, type IsoDate, windowsOverlap } from '../domain/time.js';
import type { ScheduleView } from '../schedule/view.js';
import { nurseName, type Rule, type RuleContext, type Violation, violation } from './types.js';

// ---------------------------------------------------------------------------
// Approved time off is absolute
// ---------------------------------------------------------------------------

export interface TimeOffParams {
  /**
   * Whether a night shift starting the evening before approved leave counts as working
   * during it. It ends on the first morning of the nurse's vacation, so most contracts say
   * yes — the nurse does not get their first day.
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
  defaultParams: { nightShiftEndingOnLeaveCounts: true },

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
              `${view.assignment.date} during approved ${describeType(request)} ` +
              `(${request.startDate} to ${request.endDate}).`,
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

function overlappingLeaveDate(
  date: IsoDate,
  shiftType: { isNight: boolean },
  request: TimeOffRequest,
  params: TimeOffParams,
): IsoDate | null {
  if (dateInRange(date, request.startDate, request.endDate)) return date;
  if (params.nightShiftEndingOnLeaveCounts && shiftType.isNight) {
    // The shift starts the day before leave begins but runs into its first morning.
    const endsOn = nextDay(date);
    if (dateInRange(endsOn, request.startDate, request.endDate)) return endsOn;
  }
  return null;
}

function nextDay(date: IsoDate): IsoDate {
  const ms = Date.parse(`${date}T00:00:00Z`) + 86_400_000;
  return new Date(ms).toISOString().slice(0, 10) as IsoDate;
}

function describeType(request: TimeOffRequest): string {
  switch (request.type) {
    case 'pto':
      return 'PTO';
    case 'fmla':
      return 'FMLA leave';
    case 'unpaid':
      return 'unpaid leave';
    case 'education':
      return 'education leave';
    case 'bereavement':
      return 'bereavement leave';
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
              `${previous.assignment.date} overlaps the ${current.shiftType.name} on ` +
              `${current.assignment.date}.`,
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
