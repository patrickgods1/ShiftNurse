/**
 * Hours rules — contracted hours, weekly caps and overtime authorisation.
 *
 * The unit runs mixed 8- and 12-hour shifts, so "did this nurse get their hours?" cannot be
 * answered by counting shifts. It has to be answered in hours, against each nurse's own FTE,
 * over the correct pay period. Part-time nurses being quietly over-scheduled and full-time
 * nurses being quietly under-scheduled are both contract problems, so the FTE rule reports
 * in both directions.
 *
 * A pay period is judged by the schedule that holds its end (`judgedPayPeriods`). One the schedule
 * opens in the middle of reads its earlier days from the published lookback tail; skipping it, as
 * every pay period cut by a schedule's edge once was, left it judged by neither schedule — 11 of a
 * year's 27 biweekly pay periods under calendar-month schedules. Where that tail is not known to be
 * complete, only hours past the contract are judged: history can only add hours, never remove them.
 */

import type { Assignment, CallBack, Id, Nurse, Unit } from '../domain/entities.js';
import {
  addDays,
  compareDates,
  dayNumber,
  daysBetween,
  describeDate,
  describeDateRange,
  type IsoDate,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  type Weekday,
  weekdayOf,
  windowDurationMinutes,
} from '../domain/time.js';
import { isElsewhere } from '../schedule/elsewhere.js';
import { holdoverHours } from '../schedule/holdover.js';
import { realMinutesIn } from '../schedule/real-minutes.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { minutesInWindow, windowBoundaryMinute, windowDayOf } from '../schedule/window-split.js';
import { hoursText } from './format.js';
import { leaveHoursBetween, type PaidLeaveCredit } from './paid-leave.js';
import {
  isWorked,
  nurseName,
  type Rule,
  type RuleContext,
  type Violation,
  violation,
} from './types.js';

/** " plus 12h paid leave", for violation messages; empty when there is none. */
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
 * real violations in noise. The contracted-hours rule selects with `judgedPayPeriods`, which
 * also judges a pay period the schedule opens in from the published history.
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

/** A pay period the contracted-hours rule judges. */
export interface JudgedPayPeriod extends DateWindow {
  /** False when the days before the schedule are not known to be complete: only "over" is judged. */
  underJudged: boolean;
}

/**
 * The pay periods a schedule judges contracted hours over: those wholly inside it, and one it
 * opens in the middle of, its earlier days read from the published tail. One running past the
 * schedule's end is left to the next schedule, which holds its end, unless `onlyComplete` is off.
 *
 * `historyFrom` (`historyCompleteFrom`) says how far that tail is complete. From the pay period's
 * first day, it is judged whole. From later, its first days are not on record, so a shortfall
 * cannot be told from a gap in the record, but hours past the contract can: history only adds
 * hours. Undefined, the caller has not said, and the pay period is judged as before — skipped, or
 * with `onlyComplete` off judged on this schedule's own shifts.
 */
export function judgedPayPeriods(
  window: DateWindow,
  unit: PayCalendar,
  onlyComplete: boolean,
  historyFrom: IsoDate | undefined,
): JudgedPayPeriod[] {
  const out: JudgedPayPeriod[] = [];
  for (const p of payPeriodsIn(window, unit, false)) {
    if (compareDates(p.end, window.end) > 0) {
      if (!onlyComplete) out.push({ ...p, underJudged: true });
    } else if (compareDates(p.start, window.start) < 0) {
      if (historyFrom === undefined) {
        if (!onlyComplete) out.push({ ...p, underJudged: true });
      } else {
        out.push({ ...p, underJudged: compareDates(historyFrom, p.start) <= 0 });
      }
    } else {
      out.push({ ...p, underJudged: true });
    }
  }
  return out;
}

/** Fixed work weeks covering a window, aligned to the contract's week start. */
export function workWeeksIn(window: DateWindow, startsOn: Weekday): DateWindow[] {
  const out: DateWindow[] = [];
  for (
    let week = workWeekOf(window.start, startsOn);
    dayNumber(week.start) <= dayNumber(window.end);
    week = workWeekOf(addDays(week.start, 7), startsOn)
  ) {
    out.push(week);
  }
  return out;
}

/**
 * The dates naming the first and last overtime windows (weeks or pay periods) a schedule judges:
 * the window-days of its first and last instants (`windowDayOf`). At a midnight start that is the
 * schedule's own first and last dates. A week that starts at a time of day moves them: under a
 * Saturday 19:00 start a schedule opening on a Saturday holds that morning, which belongs to the
 * week from the Saturday before; judging from the schedule's first date would leave that week,
 * and its published hours, unchecked. The rule, both solvers and the alerts select windows here.
 */
export function judgedSpan(window: DateWindow, startMinute = 0): DateWindow {
  return {
    start: windowDayOf(windowBoundaryMinute(window.start), startMinute),
    end: windowDayOf(windowBoundaryMinute(window.end) + MINUTES_PER_DAY - 1, startMinute),
  };
}

/**
 * Where work weeks start, as the rule's params, pay's `CostContext` and the alerts' input all
 * carry it: the unit's week, and optionally a separate one for nurses on permanent nights.
 */
export interface WorkWeekSettings {
  workWeekStartsOn: Weekday;
  workWeekStartMinute?: number;
  nightWorkWeekStartsOn?: Weekday;
  nightWorkWeekStartMinute?: number;
}

/** One nurse's work week: the weekday it starts on and the wall minute on that day. */
export interface WorkWeek {
  startsOn: Weekday;
  startMinute: number;
}

/**
 * The work week a nurse's weekly cap and overtime are judged on. A workweek belongs to the
 * employee and may differ between groups (29 CFR 778.105), and contracts give night nurses their
 * own so their nights are not split (Providence Portland–ONA Art. 7.A). It is chosen by the
 * nurse's `permanentTour`, never per shift: a week chosen by the shift would let one stretch of
 * hours be counted in two overlapping weeks, or in neither. A pay period keeps its anchor dates
 * and takes only `startMinute`. With no night week set, everyone is on the unit's.
 */
export function workWeekFor(
  nurse: Pick<Nurse, 'permanentTour'> | undefined,
  settings: WorkWeekSettings,
): WorkWeek {
  if (settings.nightWorkWeekStartsOn !== undefined && nurse?.permanentTour === 'night') {
    return {
      startsOn: settings.nightWorkWeekStartsOn,
      startMinute: settings.nightWorkWeekStartMinute ?? 0,
    };
  }
  return { startsOn: settings.workWeekStartsOn, startMinute: settings.workWeekStartMinute ?? 0 };
}

/** The work week containing `date`, from the contract's week-start weekday. */
export function workWeekOf(date: IsoDate, startsOn: Weekday): DateWindow {
  const start = addDays(date, -((weekdayOf(date) - startsOn + 7) % 7));
  return { start, end: addDays(start, 6) };
}

// ---------------------------------------------------------------------------
// Contracted hours / FTE
// ---------------------------------------------------------------------------

export interface ContractedHoursParams {
  /** Hours a nurse may fall short of their contracted total before it is a violation. */
  underToleranceHours: number;
  /** Hours a nurse may exceed it by. */
  overToleranceHours: number;
  /**
   * Skip pay periods only partly covered by this schedule — unless the earlier part is already
   * published (`judgedPayPeriods`). Almost always correct.
   */
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
    'to, per pay period. Hours past the contract are refused unless the shift is marked as ' +
    'authorised overtime; a shortfall is reported as advice (soft) unless the rule is set to hard, ' +
    'for contracts that guarantee full hours.',
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
        'pick up extra and you accept that. Shifts marked as authorised overtime do not count ' +
        'against this.',
    },
    onlyCompletePayPeriods: {
      label: 'Only judge whole pay periods',
      hint: 'Skip pay periods this schedule only partly covers, unless the earlier part is already published.',
      why:
        'Leave this on. A pay period that began before this schedule is judged with the published ' +
        "schedule before it; one that runs past this schedule's end is left to the next one. Off, " +
        'every pay period touching the schedule is judged with only what is on record.',
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
    const periods = judgedPayPeriods(
      { start: schedule.period.startDate, end: schedule.period.endDate },
      ctx.unit,
      params.onlyCompletePayPeriods,
      ctx.historyFrom,
    );
    if (periods.length === 0) return violations;
    // Without `historyFrom` nobody has said the tail is whole, so a pay period is judged on this
    // schedule's shifts alone, as it always was.
    const withHistory = ctx.historyFrom !== undefined;

    for (const nurse of ctx.nurses) {
      if (!nurse.active) continue;
      const exempt = params.exemptEmploymentTypes.includes(nurse.employmentType);

      for (const period of periods) {
        const target = nurse.contractedHoursPerPeriod;
        // No contracted total (per-diem, agency) means nothing to be over or under: every shift
        // such a nurse picks up would otherwise read as "over" a contract that was never made.
        if (target <= 0) continue;
        const found = hoursInPayPeriod(schedule, nurse.id, period, params, ctx, withHistory);
        const { scheduledHours: hours, priorHours, paidLeaveHours, assignmentIds } = found;
        const delta = hours + paidLeaveHours - target;
        // Authorised overtime is a recorded, deliberate excess — as `max-hours-per-week` treats
        // it — so it is left out of "over". "Under" still counts it: a nurse who worked an
        // overtime shift is not short of those hours.
        const overtime = found.authorisedOvertimeHours;
        const overDelta = delta - overtime;
        const figure =
          `${hoursText(hours)}` +
          (priorHours > 0 ? ` (${hoursText(priorHours)} of it before this schedule)` : '') +
          leaveNote(paidLeaveHours);
        const details = {
          scheduledHours: hours,
          ...(priorHours > 0 ? { priorHours } : {}),
          paidLeaveHours,
          targetHours: target,
          deltaHours: delta,
          payPeriod: { start: period.start, end: period.end },
        };

        if (!exempt && period.underJudged && delta < -params.underToleranceHours) {
          violations.push(
            violation(
              contractedHoursRule,
              // Advisory: a shortfall is the manager's call (a nurse who asked for fewer
              // shifts, a unit over-staffed that week). A rule set can make it hard.
              'soft',
              'under_contracted_hours',
              `${nurseName(nurse)} is scheduled ${figure} ` +
                `in the pay period ${describeDateRange(period.start, period.end)}, ` +
                `${hoursText(Math.abs(delta))} short of their contracted ${hoursText(target)} ` +
                `(${nurse.fte} FTE).`,
              {
                amount: -delta,
                nurseIds: [nurse.id],
                dates: [period.start, period.end],
                assignmentIds,
                details,
              },
            ),
          );
        } else if (overDelta > params.overToleranceHours && found.straightTimeIds.length > 0) {
          // Only with a straight-time shift of this schedule in it: history (or leave) alone over
          // the contract is nothing this schedule can fix, a hard finding must name what to move,
          // and taking off an overtime shift would not shrink it.
          violations.push(
            violation(
              contractedHoursRule,
              'hard',
              'over_contracted_hours',
              `${nurseName(nurse)} is scheduled ${figure} ` +
                `in the pay period ${describeDateRange(period.start, period.end)}` +
                (overtime > 0 ? ` (${hoursText(overtime)} of it authorised overtime)` : '') +
                `, ${hoursText(overDelta)} over their contracted ${hoursText(target)} ` +
                `(${nurse.fte} FTE).`,
              {
                amount: overDelta,
                nurseIds: [nurse.id],
                dates: [period.start, period.end],
                assignmentIds: found.straightTimeIds,
                details: { ...details, authorisedOvertimeHours: overtime, deltaHours: overDelta },
              },
            ),
          );
        }
      }
    }

    return violations;
  },
};

/** A nurse's hours in one pay period, as the contracted-hours rule counts them. */
export interface PayPeriodHours {
  /** This unit's scheduled hours dated in the pay period, history included. */
  scheduledHours: number;
  /** The part dated before the schedule. */
  priorHours: number;
  /** 0 when `paidLeaveCountsTowardHours` is off. */
  paidLeaveHours: number;
  /**
   * The part of `scheduledHours` on shifts marked authorised overtime, history included: the
   * over-contract check leaves it out, the under-contract check does not.
   */
  authorisedOvertimeHours: number;
  /** In-period contributors only: the lookback is published and not this schedule's to move. */
  assignmentIds: Id[];
}

interface CountedHours extends PayPeriodHours {
  /** `assignmentIds` less those marked authorised overtime: what "over" names. */
  straightTimeIds: Id[];
}

/**
 * A nurse's hours in a pay period, as `fte-target-hours` counts them: scheduled (not worked)
 * hours, standby only when the rule counts it, the published tail included, and never another
 * unit's shifts — those are that unit's contract, not this one's.
 *
 * The published tail is always included here. The rule itself drops lookback rows when
 * `RuleContext.historyFrom` is absent (nobody has said the tail is whole), so a caller that must
 * match the rule's figure does the same: use `scheduledHours − priorHours` in that case.
 */
export function payPeriodHoursFor(
  schedule: ScheduleView,
  nurseId: Id,
  payPeriod: DateWindow,
  params: ContractedHoursParams,
  ctx: Pick<RuleContext, 'paidLeaveByNurse'>,
): PayPeriodHours {
  const { straightTimeIds: _, ...hours } = hoursInPayPeriod(
    schedule,
    nurseId,
    payPeriod,
    params,
    ctx,
    true,
  );
  return hours;
}

function hoursInPayPeriod(
  schedule: ScheduleView,
  nurseId: Id,
  payPeriod: DateWindow,
  params: ContractedHoursParams,
  ctx: Pick<RuleContext, 'paidLeaveByNurse'>,
  withHistory: boolean,
): CountedHours {
  const out: CountedHours = {
    scheduledHours: 0,
    priorHours: 0,
    paidLeaveHours: params.paidLeaveCountsTowardHours
      ? leaveHoursBetween(ctx.paidLeaveByNurse.get(nurseId), payPeriod.start, payPeriod.end)
      : 0,
    authorisedOvertimeHours: 0,
    assignmentIds: [],
    straightTimeIds: [],
  };
  for (const view of schedule.timelineFor(nurseId)) {
    if (!view.inPeriod && !withHistory) continue;
    if (!params.onCallCountsTowardHours && !isWorked(view)) continue;
    if (isElsewhere(view.shiftType)) continue;
    if (compareDates(view.assignment.date, payPeriod.start) < 0) continue;
    if (compareDates(view.assignment.date, payPeriod.end) > 0) continue;
    // Scheduled, not worked: the contract is what the manager rostered, and a holdover
    // is priced as overtime rather than refused as hours past the FTE.
    out.scheduledHours += view.scheduledHours;
    if (view.assignment.isOvertime) out.authorisedOvertimeHours += view.scheduledHours;
    if (view.inPeriod) {
      out.assignmentIds.push(view.assignment.id);
      if (!view.assignment.isOvertime) out.straightTimeIds.push(view.assignment.id);
    } else {
      out.priorHours += view.scheduledHours;
    }
  }
  return out;
}

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
   * The time on `workWeekStartsOn` the work week begins, in minutes after midnight (0–1439). A
   * week (or, with `overtimeByPayPeriod`, a pay period) dated `start..end` runs from that minute
   * on `start` to the same minute after `end` (`windowBoundaryMinute`). Payroll often sets it at
   * the shift change nearest midnight (Saturday 19:00 for 12-hour staff) so no night is split.
   * Optional in a stored rule set: absent is midnight, the reading before it existed.
   */
  workWeekStartMinute?: number;
  /**
   * A separate work week for nurses whose `permanentTour` is nights (`workWeekFor`). Absent, they
   * share the unit's. It moves only weekly windows: a pay period keeps its anchor dates.
   */
  nightWorkWeekStartsOn?: Weekday;
  /**
   * The time on `nightWorkWeekStartsOn` the night nurses' week begins (0–1439; absent, midnight),
   * and the minute their pay periods begin on the usual dates. Read only with
   * `nightWorkWeekStartsOn` set.
   */
  nightWorkWeekStartMinute?: number;
  /**
   * When true, hours past the overtime threshold must be covered: by a shift marked as
   * authorised overtime, which authorises its whole week (or pay period), or by recorded holdover
   * time, which authorises only its own hours (`authorisedOvertimeHours`). Unauthorised overtime
   * is a budget and contract problem, so it is caught rather than silently costed.
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

/**
 * The overtime window holding `at`: a shift's start (a wall minute), placed against the work
 * week's start time, or a date, read as its midnight. `week` is the nurse's (`workWeekFor`);
 * absent, the unit's.
 */
export function overtimeWindowOf(
  at: IsoDate | number,
  params: MaxHoursParams,
  calendar: PayCalendar,
  week: WorkWeek = workWeekFor(undefined, params),
): DateWindow {
  const minute = typeof at === 'number' ? at : windowBoundaryMinute(at);
  const date = windowDayOf(minute, week.startMinute);
  if (params.overtimeByPayPeriod) return payPeriodWindow(payPeriodIndex(date, calendar), calendar);
  return workWeekOf(date, week.startsOn);
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

/**
 * Overtime hours a window's own records authorise: all of it when a shift in the window is
 * marked authorised overtime, otherwise the hours recorded holdovers add — recording a holdover
 * authorises the time it adds, nothing more. The rule and the CP-SAT cap both ask this.
 */
export function authorisedOvertimeHours(
  rows: Iterable<Pick<Assignment, 'isOvertime' | 'holdoverMinutes'>>,
): number {
  let hours = 0;
  for (const row of rows) {
    if (row.isOvertime) return Number.POSITIVE_INFINITY;
    hours += holdoverHours(row);
  }
  return hours;
}

interface WindowHours {
  hours: number;
  /** What the window's own records authorise past the threshold (`authorisedOvertimeHours`). */
  authorisedHours: number;
  touchesPeriod: boolean;
  assignmentIds: Id[];
}

/** What `hoursIn` needs to count a window as the unit's payroll does (21 Q1). */
export type WindowReading = Pick<RuleContext, 'overtimeWindowAttribution' | 'dstTransitions'>;

/**
 * A window's hours, as `max-hours-per-week` counts them. The window runs from `startMinute` on its
 * first date to the same minute after its last (`windowBoundaryMinute`). Without a pay attribution
 * (no pay settings loaded) a shift counts whole in the window its start falls in, at its paid
 * hours. With one, it counts real minutes, so the DST nights are 11 and 13 hours as payroll pays
 * them; by the clock a night crossing the window's edge gives each side the minutes worked there,
 * which is why a view that starts before the window can add to it (and is named, when in-period,
 * since it makes the window worse). Either way only rows that start in the window authorise its
 * overtime. At `startMinute` 0 "starts in" is "is dated in".
 *
 * `callBacks` (time called in from standby) count under the same reading as shifts, and one that
 * starts in the window authorises its own hours, as a recorded holdover does: the manager called
 * the nurse in. They never touch the period, so a window holding only history stays unjudged.
 */
function hoursIn(
  timeline: readonly AssignmentView[],
  window: DateWindow,
  reading?: WindowReading,
  startMinute = 0,
  callBacks: readonly CallBack[] = [],
): WindowHours {
  const out: WindowHours = {
    hours: 0,
    authorisedHours: 0,
    touchesPeriod: false,
    assignmentIds: [],
  };
  const rows: Assignment[] = [];
  const attribution = reading?.overtimeWindowAttribution;
  const tz = reading?.dstTransitions ?? [];
  const opens = windowBoundaryMinute(window.start, startMinute);
  const nextStart = addDays(window.end, 1);
  let minutes = 0;
  for (const view of timeline) {
    // The window-day the shift starts on: its date, unless the week starts at a time of day.
    const day = windowDayOf(view.window.startMinute, startMinute);
    if (compareDates(day, window.end) > 0) continue;
    const dated = compareDates(day, window.start) >= 0;
    if (attribution === undefined) {
      if (!dated) continue;
      // `paidHours` is worked time, so the absolute cap counts a holdover whatever it authorises.
      out.hours += view.paidHours;
    } else if (attribution === 'start') {
      if (!dated) continue;
      minutes += realMinutesIn(view.window, tz);
    } else {
      if (!dated && view.window.endMinute <= opens) continue;
      const worked = minutesInWindow(view, window.start, nextStart, tz, startMinute);
      if (!dated && worked <= 0) continue;
      minutes += worked;
    }
    if (dated) rows.push(view.assignment);
    if (view.inPeriod) {
      out.touchesPeriod = true;
      out.assignmentIds.push(view.assignment.id);
    }
  }
  let calledInHours = 0;
  for (const cb of callBacks) {
    const day = windowDayOf(cb.window.startMinute, startMinute);
    if (compareDates(day, window.end) > 0) continue;
    const dated = compareDates(day, window.start) >= 0;
    if (attribution === undefined) {
      if (!dated) continue;
      out.hours += windowDurationMinutes(cb.window) / MINUTES_PER_HOUR;
    } else if (attribution === 'start') {
      if (!dated) continue;
      minutes += realMinutesIn(cb.window, tz);
    } else {
      if (!dated && cb.window.endMinute <= opens) continue;
      minutes += minutesInWindow(cb, window.start, nextStart, tz, startMinute);
    }
    if (dated) calledInHours += windowDurationMinutes(cb.window) / MINUTES_PER_HOUR;
  }
  // Whole minutes, converted once: summed as float hours a 40-hour week could read 40.0000001.
  if (attribution !== undefined) out.hours = minutes / MINUTES_PER_HOUR;
  // Lookback rows count: a holdover last period recorded in this week authorised its hours.
  out.authorisedHours = authorisedOvertimeHours(rows) + calledInHours;
  return out;
}

/**
 * A window's hours as `max-hours-per-week` counts them (`hoursIn`), and whether an in-period row
 * adds to them. For the compliance alerts that weigh one reading of a window against another.
 */
export function windowHours(
  timeline: readonly AssignmentView[],
  window: DateWindow,
  reading: WindowReading | undefined,
  startMinute: number,
): { hours: number; touchesPeriod: boolean; assignmentIds: Id[] } {
  const { hours, touchesPeriod, assignmentIds } = hoursIn(timeline, window, reading, startMinute);
  return { hours, touchesPeriod, assignmentIds };
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
    workWeekStartMinute: 0,
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
      max: 168,
    },
    overtimeThresholdHours: {
      label: 'Weekly overtime after (hours)',
      min: 1,
      hint: 'Hours in a work week past which the week counts as overtime.',
      why: "Usually 40, the US federal threshold. Use your contract's number if it differs.",
      activeWhen: { param: 'overtimeByPayPeriod', equals: false },
      max: 168,
    },
    workWeekStartsOn: {
      label: 'Work week starts on',
      hint: 'The first day of the work week used for the hour cap and weekly overtime.',
      why: 'Match payroll. If payroll counts Sunday to Saturday, pick Sunday.',
      input: 'weekday',
    },
    workWeekStartMinute: {
      label: 'Work week starts at',
      input: 'time-of-day',
      integer: true,
      min: 0,
      max: 1439,
      hint:
        'The time on the first day when the work week begins. Midnight unless payroll starts the ' +
        'week at a shift change.',
      why:
        'A work week may begin on any day and at any hour (29 CFR 778.105). Match payroll: it is ' +
        'often the shift change nearest midnight, such as 19:00 Saturday, so no night is split ' +
        'between two weeks. A change should be permanent; in the week it changes, payroll owes ' +
        'the greater of the two counts (29 CFR 778.302).',
    },
    nightWorkWeekStartsOn: {
      label: "Night nurses' work week starts on",
      input: 'weekday',
      optional: true,
      hint: "Only for nurses whose permanent tour is nights. Leave empty to use the unit's work week.",
      why:
        'A work week may begin on any day and at any hour, and may differ for different groups ' +
        'of employees (29 CFR 778.105). Some contracts give night nurses their own so their ' +
        'nights stay whole: Providence Portland–ONA Art. 7.A starts it at 12:01 a.m. Saturday ' +
        'or the night shift closest to it; Kaiser NW–OFNHP 10.A.2 sets one for nights on 7/70. ' +
        'A nurse is on one week, chosen by her permanent tour, never by the shift.',
    },
    nightWorkWeekStartMinute: {
      label: "Night nurses' work week starts at",
      input: 'time-of-day',
      optional: true,
      integer: true,
      min: 0,
      max: 1439,
      hint:
        "The time on that day the night nurses' week begins; empty is midnight. With overtime " +
        'by pay period, their pay periods begin at this time on the usual dates.',
      why:
        'Match payroll, which sets this per employee (29 CFR 778.105). Providence Portland–ONA ' +
        'Art. 7.A begins the night week with the night shift closest to 12:01 a.m. Saturday, ' +
        'such as 19:00 Friday or Saturday. A pay period cannot start on another weekday, so ' +
        'only the time moves it.',
    },
    requireOvertimeAuthorisation: {
      label: 'Overtime must be authorised',
      hint:
        'Hours past the threshold need a shift marked as authorised overtime (covers the whole ' +
        'week or pay period) or recorded holdover time (covers only its own hours).',
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
    // At most two grids, the unit's and the night nurses', built once rather than per nurse:
    // the solver evaluates this rule on one-nurse views millions of times.
    const grids = new Map<string, { weeks: DateWindow[]; payPeriods: DateWindow[] }>();
    const gridFor = (week: WorkWeek) => {
      const key = `${week.startsOn}:${week.startMinute}`;
      let grid = grids.get(key);
      if (grid === undefined) {
        const span = judgedSpan(window, week.startMinute);
        grid = {
          weeks: workWeeksIn(span, week.startsOn),
          // Weekly overtime is judged in the cap's own loop, so a week over the cap reports that alone.
          payPeriods: params.overtimeByPayPeriod ? payPeriodsIn(span, ctx.unit, false) : [],
        };
        grids.set(key, grid);
      }
      return grid;
    };

    for (const nurse of ctx.nurses) {
      const week = workWeekFor(nurse, params);
      const startMinute = week.startMinute;
      const { weeks, payPeriods } = gridFor(week);
      const timeline = schedule
        .timelineFor(nurse.id)
        .filter((v) => params.onCallCountsTowardHours || isWorked(v));
      const callBacks = ctx.callBacksByNurse.get(nurse.id) ?? [];

      const unauthorised = (span: DateWindow, found: WindowHours) => {
        if (!params.requireOvertimeAuthorisation) return;
        const paidLeaveHours = params.paidLeaveCountsTowardOvertime
          ? leaveHoursBetween(ctx.paidLeaveByNurse.get(nurse.id), span.start, span.end)
          : 0;
        const threshold = overtimeThreshold(params);
        const overtimeHours = found.hours + paidLeaveHours - threshold - found.authorisedHours;
        if (overtimeHours <= 0) return;
        const unit = params.overtimeByPayPeriod ? 'pay period' : 'week';
        violations.push(
          violation(
            maxHoursRule,
            'hard',
            'unauthorised_overtime',
            `${nurseName(nurse)} is scheduled ${hoursText(found.hours)}${leaveNote(paidLeaveHours)} ` +
              `in ${windowName(span, params)}, which is ${hoursText(overtimeHours)} of overtime` +
              (found.authorisedHours > 0
                ? ` beyond the ${hoursText(found.authorisedHours)} held over`
                : '') +
              `, but no shift that ${unit} is marked as authorised overtime.`,
            {
              amount: overtimeHours,
              nurseIds: [nurse.id],
              dates: [span.start, span.end],
              assignmentIds: found.assignmentIds,
              details: {
                scheduledHours: found.hours,
                paidLeaveHours,
                overtimeHours,
                authorisedHours: found.authorisedHours,
                threshold,
                ...(params.overtimeByPayPeriod ? { payPeriod: span } : { week: span }),
              },
            },
          ),
        );
      };

      for (const week of weeks) {
        const found = hoursIn(timeline, week, ctx, startMinute, callBacks);
        if (!found.touchesPeriod) continue;

        if (found.hours > params.maxHoursPerWeek) {
          violations.push(
            violation(
              maxHoursRule,
              'hard',
              'over_max_hours',
              `${nurseName(nurse)} is scheduled ${hoursText(found.hours)} in the week of ` +
                `${describeDate(week.start)}, over the ${hoursText(params.maxHoursPerWeek)} cap.`,
              {
                amount: found.hours - params.maxHoursPerWeek,
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
        const found = hoursIn(timeline, pay, ctx, startMinute, callBacks);
        if (found.touchesPeriod) unauthorised(pay, found);
      }
    }

    return violations;
  },
};

/**
 * Hours past the overtime threshold in the nurse's own overtime window (`workWeekFor`; work week
 * or pay period) holding `at` (a shift's start minute, or a date's midnight; `overtimeWindowOf`),
 * counted as `max-hours-per-week` counts them: standby only when the rule counts it, paid leave only when it
 * counts toward overtime, a week-crossing night by `reading` (the rule context; absent, the start
 * week at declared hours). Authorised or not — it is what the window adds to
 * payroll. Used by the exchange evaluator to show what a trade does to each side's overtime.
 */
export function overtimeHoursAround(
  schedule: ScheduleView,
  nurseId: Id,
  at: IsoDate | number,
  params: MaxHoursParams,
  calendar: PayCalendar,
  paidLeave: readonly PaidLeaveCredit[] | undefined,
  reading?: WindowReading,
): number {
  const week = workWeekFor(schedule.nursesById.get(nurseId), params);
  const window = overtimeWindowOf(at, params, calendar, week);
  const timeline = schedule
    .timelineFor(nurseId)
    .filter((v) => params.onCallCountsTowardHours || isWorked(v));
  const found = hoursIn(timeline, window, reading, week.startMinute);
  const leave = params.paidLeaveCountsTowardOvertime
    ? leaveHoursBetween(paidLeave, window.start, window.end)
    : 0;
  return Math.max(0, found.hours + leave - overtimeThreshold(params));
}
