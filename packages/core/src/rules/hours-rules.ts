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
  describeDate,
  describeDateRange,
  fromDayNumber,
  type IsoDate,
  type Weekday,
  weekdayOf,
} from '../domain/time.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { leaveHoursBetween } from './paid-leave.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

/** " plus 12h paid leave", for violation messages; empty when there is none. */
/** Hours to one decimal place, with no trailing `.0`: "48h", "6.5h". */
function hoursText(hours: number): string {
  return `${Math.round(hours * 10) / 10}h`;
}

function leaveNote(hours: number): string {
  return hours > 0 ? ` plus ${hoursText(hours)} paid leave` : '';
}

export interface DateWindow {
  start: IsoDate;
  end: IsoDate;
}

// ---------------------------------------------------------------------------
// Pay periods
// ---------------------------------------------------------------------------

/** All the pay-period maths reads of a unit. */
export type PayCalendar = Pick<Unit, 'payPeriodAnchor' | 'payPeriodDays'>;

/** Which pay period a date falls in, counted from the unit's anchor date. */
export function payPeriodIndex(date: IsoDate, unit: PayCalendar): number {
  return Math.floor(daysBetween(unit.payPeriodAnchor, date) / unit.payPeriodDays);
}

export function payPeriodWindow(index: number, unit: PayCalendar): DateWindow {
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
export function payPeriodsIn(
  window: DateWindow,
  unit: PayCalendar,
  onlyComplete: boolean,
): DateWindow[] {
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
  /**
   * Whether approved paid leave and paid sick calls count toward the contracted total. They
   * do: payroll pays those hours, and a nurse back from a paid week off is not short of their
   * FTE. See `paid-leave.ts`.
   */
  paidLeaveCountsTowardHours: boolean;
}

export const contractedHoursRule: Rule<ContractedHoursParams> = {
  id: 'fte-target-hours',
  name: 'Contracted hours (FTE)',
  description:
    "Each nurse's scheduled hours must land within tolerance of the hours their FTE entitles them " +
    'to, per pay period. Hours past the contract are refused; a shortfall is reported as advice ' +
    '(soft) unless the rule is set to hard, for contracts that guarantee full hours.',
  severity: 'hard',
  category: 'hours',
  scope: 'nurse',
  defaultParams: {
    underToleranceHours: 4,
    overToleranceHours: 4,
    onlyCompletePayPeriods: true,
    exemptEmploymentTypes: ['per_diem', 'agency'],
    onCallCountsTowardHours: false,
    paidLeaveCountsTowardHours: true,
  },
  paramDocs: {
    underToleranceHours: {
      label: 'Allowed shortfall (hours)',
      hint: 'How far under their contracted hours a nurse may be scheduled in a pay period.',
      why:
        'A little slack (about one short shift) lets the solver balance the team. Set it to 0 ' +
        'if nurses must always get their full hours; raise it if short hours are routine.',
    },
    overToleranceHours: {
      label: 'Allowed overage (hours)',
      hint: 'How far over their contracted hours a nurse may be scheduled in a pay period.',
      why:
        'Keep it small to spread shifts fairly and keep overtime down. Raise it if staff often ' +
        'pick up extra and you accept that.',
    },
    onlyCompletePayPeriods: {
      label: 'Only judge whole pay periods',
      hint: 'Skip pay periods the schedule only partly covers.',
      why:
        'Leave this on. A schedule that ends mid pay period would otherwise flag everyone as ' +
        'short for the half it does not cover.',
    },
    exemptEmploymentTypes: {
      label: 'No minimum for',
      hint: 'Employment types with no contracted minimum, so being under hours is never flagged.',
      why:
        'Per-diem and agency staff work as needed and have no minimum. Tick any other type your ' +
        'unit schedules the same way.',
      input: 'employment-types',
    },
    onCallCountsTowardHours: {
      label: 'On-call counts toward hours',
      hint: "Whether standby hours count toward a nurse's contracted total.",
      why: 'Usually off. Turn it on if your contract credits time on call as hours worked.',
    },
    paidLeaveCountsTowardHours: {
      label: 'Paid leave counts toward hours',
      hint: 'Whether approved paid leave and paid sick calls count toward the contracted total.',
      why:
        'Leave this on: payroll pays those hours, so a nurse back from a paid week off is not ' +
        'short. Turn it off only if your contract says leave does not count.',
    },
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
        // No contracted total (per-diem, agency) means nothing to be over or under: every shift
        // such a nurse picks up would otherwise read as "over" a contract that was never made.
        if (target <= 0) continue;
        const paidLeaveHours = params.paidLeaveCountsTowardHours
          ? leaveHoursBetween(ctx.paidLeaveByNurse.get(nurse.id), period.start, period.end)
          : 0;
        const delta = hours + paidLeaveHours - target;

        if (!exempt && delta < -params.underToleranceHours) {
          violations.push(
            violation(
              contractedHoursRule,
              // Advisory: a shortfall is the manager's call (a nurse who asked for fewer
              // shifts, a unit over-staffed that week). A rule set can make it hard.
              'soft',
              'under_contracted_hours',
              `${nurseName(nurse)} is scheduled ${hoursText(hours)}${leaveNote(paidLeaveHours)} ` +
                `in the pay period ${describeDateRange(period.start, period.end)}, ` +
                `${hoursText(Math.abs(delta))} short of their contracted ${hoursText(target)} ` +
                `(${nurse.fte} FTE).`,
              {
                nurseIds: [nurse.id],
                dates: [period.start, period.end],
                assignmentIds,
                details: {
                  scheduledHours: hours,
                  paidLeaveHours,
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
              `${nurseName(nurse)} is scheduled ${hoursText(hours)}${leaveNote(paidLeaveHours)} ` +
                `in the pay period ${describeDateRange(period.start, period.end)}, ` +
                `${hoursText(delta)} over their contracted ${hoursText(target)} (${nurse.fte} FTE).`,
              {
                nurseIds: [nurse.id],
                dates: [period.start, period.end],
                assignmentIds,
                details: {
                  scheduledHours: hours,
                  paidLeaveHours,
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
  /** Hours past which the week counts as overtime (when overtime is weekly). */
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
  /**
   * Whether paid leave in the week counts toward the overtime threshold. Off by default: under
   * federal wage-and-hour law paid leave is not hours worked, so 36 worked hours and a PTO day
   * are not overtime. Some union contracts count it; they turn this on. Leave never counts
   * toward `maxHoursPerWeek` — that cap is about fatigue, and a day off is not tiring.
   */
  paidLeaveCountsTowardOvertime: boolean;
  /**
   * Judge overtime over the unit's pay period instead of the work week, against
   * `payPeriodOvertimeThresholdHours`. Six 12s and an 8 a fortnight is 44h one week and 36h the
   * next: a weekly threshold calls the long week overtime, a fortnightly one sees exactly 80h.
   * That is how a hospital on the FLSA's 14-day overtime period (29 U.S.C. §207(j)) or a
   * federal biweekly compressed schedule counts it. `maxHoursPerWeek` still binds every week —
   * it is about fatigue, not pay.
   */
  overtimeByPayPeriod: boolean;
  /** Hours past which a pay period counts as overtime, when `overtimeByPayPeriod` is on. */
  payPeriodOvertimeThresholdHours: number;
}

/** The overtime window containing `date`. */
export function overtimeWindowOf(
  date: IsoDate,
  params: MaxHoursParams,
  calendar: PayCalendar,
): DateWindow {
  if (params.overtimeByPayPeriod) return payPeriodWindow(payPeriodIndex(date, calendar), calendar);
  const start = addDays(date, -((weekdayOf(date) - params.workWeekStartsOn + 7) % 7));
  return { start, end: addDays(start, 6) };
}

/** Hours past which one overtime window is overtime. */
export function overtimeThreshold(params: MaxHoursParams): number {
  return params.overtimeByPayPeriod
    ? params.payPeriodOvertimeThresholdHours
    : params.overtimeThresholdHours;
}

/** "the week of 2026-01-04" or "the pay period from 2026-01-04", for messages. */
function windowName(window: DateWindow, params: MaxHoursParams): string {
  return params.overtimeByPayPeriod
    ? `the pay period from ${describeDate(window.start)}`
    : `the week of ${describeDate(window.start)}`;
}

interface WindowHours {
  hours: number;
  authorised: boolean;
  touchesPeriod: boolean;
  assignmentIds: Id[];
}

function hoursIn(timeline: readonly AssignmentView[], window: DateWindow): WindowHours {
  const out: WindowHours = { hours: 0, authorised: false, touchesPeriod: false, assignmentIds: [] };
  for (const view of timeline) {
    if (compareDates(view.assignment.date, window.start) < 0) continue;
    if (compareDates(view.assignment.date, window.end) > 0) continue;
    out.hours += view.paidHours;
    if (view.assignment.isOvertime) out.authorised = true;
    if (view.inPeriod) {
      out.touchesPeriod = true;
      out.assignmentIds.push(view.assignment.id);
    }
  }
  return out;
}

export const maxHoursRule: Rule<MaxHoursParams> = {
  id: 'max-hours-per-week',
  name: 'Weekly hour cap and overtime authorisation',
  description:
    'Caps hours in a single work week and requires overtime to be explicitly authorised rather than ' +
    'appearing by accident. Overtime is judged per work week or, where the contract says so, per ' +
    'pay period.',
  severity: 'hard',
  category: 'hours',
  scope: 'nurse',
  defaultParams: {
    maxHoursPerWeek: 48,
    overtimeThresholdHours: 40,
    workWeekStartsOn: 0,
    requireOvertimeAuthorisation: true,
    onCallCountsTowardHours: false,
    paidLeaveCountsTowardOvertime: false,
    overtimeByPayPeriod: false,
    payPeriodOvertimeThresholdHours: 80,
  },
  paramDocs: {
    maxHoursPerWeek: {
      label: 'Weekly hour cap',
      min: 1,
      hint: 'The most hours anyone may be scheduled in a work week, overtime or not.',
      why:
        'A fatigue limit, often 48 to 60. It binds every week even when overtime is judged by ' +
        'pay period. Lower it to protect staff; raising it gives more room to cover gaps.',
    },
    overtimeThresholdHours: {
      label: 'Weekly overtime after (hours)',
      min: 1,
      hint: 'Hours in a work week past which the week counts as overtime.',
      why: "Usually 40, the US federal threshold. Use your contract's number if it differs.",
      activeWhen: { param: 'overtimeByPayPeriod', equals: false },
    },
    workWeekStartsOn: {
      label: 'Work week starts on',
      hint: 'The first day of the work week used for the hour cap and weekly overtime.',
      why: 'Match payroll. If payroll counts Sunday to Saturday, pick Sunday.',
      input: 'weekday',
    },
    requireOvertimeAuthorisation: {
      label: 'Overtime must be authorised',
      hint: 'A week or pay period over the threshold needs a shift marked as authorised overtime.',
      why:
        'Leave this on to stop overtime appearing by accident. Mark the shift as overtime on the ' +
        'grid when you mean it. Turn it off if overtime needs no sign-off on your unit.',
    },
    onCallCountsTowardHours: {
      label: 'On-call counts toward hours',
      hint: 'Whether standby hours count toward the cap and the overtime threshold.',
      why: 'Usually off. Turn it on if your contract counts time on call as hours worked.',
    },
    paidLeaveCountsTowardOvertime: {
      label: 'Paid leave counts toward overtime',
      hint: 'Whether paid leave in the week counts toward the overtime threshold.',
      why:
        'Off under US federal law: paid leave is not hours worked, so 36 worked hours and a paid ' +
        'day off are not overtime. Some union contracts count it; turn it on if yours does. ' +
        'Leave never counts toward the weekly cap.',
    },
    overtimeByPayPeriod: {
      label: 'Judge overtime by pay period',
      hint: 'Count overtime over the whole pay period instead of each work week.',
      why:
        'For hospitals on a 14-day overtime period (8/80) or a biweekly compressed schedule, ' +
        'where one week of 44 hours and one of 36 is not overtime. The weekly cap still applies.',
    },
    payPeriodOvertimeThresholdHours: {
      label: 'Pay-period overtime after (hours)',
      min: 1,
      hint: 'Hours in a pay period past which it counts as overtime.',
      why: "Usually 80 for a two-week pay period. Use your contract's number if it differs.",
      activeWhen: { param: 'overtimeByPayPeriod', equals: true },
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    const window = { start: schedule.period.startDate, end: schedule.period.endDate };
    const weeks = workWeeksIn(window, params.workWeekStartsOn);
    // Weekly overtime is judged in the cap's own loop, so a week over the cap reports that alone.
    const payPeriods = params.overtimeByPayPeriod ? payPeriodsIn(window, ctx.unit, false) : [];

    for (const nurse of ctx.nurses) {
      const timeline = schedule
        .timelineFor(nurse.id)
        .filter((v) => params.onCallCountsTowardHours || isWorked(v));

      const unauthorised = (span: DateWindow, found: WindowHours) => {
        if (!params.requireOvertimeAuthorisation || found.authorised) return;
        const paidLeaveHours = params.paidLeaveCountsTowardOvertime
          ? leaveHoursBetween(ctx.paidLeaveByNurse.get(nurse.id), span.start, span.end)
          : 0;
        const threshold = overtimeThreshold(params);
        const overtimeHours = found.hours + paidLeaveHours - threshold;
        if (overtimeHours <= 0) return;
        const unit = params.overtimeByPayPeriod ? 'pay period' : 'week';
        violations.push(
          violation(
            maxHoursRule,
            'hard',
            'unauthorised_overtime',
            `${nurseName(nurse)} is scheduled ${found.hours}h${leaveNote(paidLeaveHours)} in ` +
              `${windowName(span, params)}, which is ${overtimeHours}h of overtime, but no shift ` +
              `that ${unit} is marked as authorised overtime.`,
            {
              nurseIds: [nurse.id],
              dates: [span.start, span.end],
              assignmentIds: found.assignmentIds,
              details: {
                scheduledHours: found.hours,
                paidLeaveHours,
                overtimeHours,
                threshold,
                ...(params.overtimeByPayPeriod ? { payPeriod: span } : { week: span }),
              },
            },
          ),
        );
      };

      for (const week of weeks) {
        const found = hoursIn(timeline, week);
        if (!found.touchesPeriod) continue;

        if (found.hours > params.maxHoursPerWeek) {
          violations.push(
            violation(
              maxHoursRule,
              'hard',
              'over_max_hours',
              `${nurseName(nurse)} is scheduled ${found.hours}h in the week of ${describeDate(week.start)}, ` +
                `over the ${params.maxHoursPerWeek}h cap.`,
              {
                nurseIds: [nurse.id],
                dates: [week.start, week.end],
                assignmentIds: found.assignmentIds,
                details: {
                  scheduledHours: found.hours,
                  maxHours: params.maxHoursPerWeek,
                  week,
                },
              },
            ),
          );
        } else if (!params.overtimeByPayPeriod) {
          unauthorised(week, found);
        }
      }

      for (const pay of payPeriods) {
        const found = hoursIn(timeline, pay);
        if (found.touchesPeriod) unauthorised(pay, found);
      }
    }

    return violations;
  },
};

/**
 * Hours past the overtime threshold in the overtime window (work week or pay period) containing
 * `date`. Used by the exchange evaluator to show what a trade does to each side's overtime.
 */
export function overtimeHoursAround(
  schedule: ScheduleView,
  nurseId: Id,
  date: IsoDate,
  params: MaxHoursParams,
  calendar: PayCalendar,
): number {
  const window = overtimeWindowOf(date, params, calendar);
  const hours = schedule.hoursBetween(nurseId, window.start, window.end);
  return Math.max(0, hours - overtimeThreshold(params));
}
