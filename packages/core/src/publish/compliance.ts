/**
 * Compliance alerts: the things a manager must know *before* a schedule goes out that the
 * rule engine does not, or cannot, say.
 *
 * The rule engine judges what is illegal today. These alerts are about what is *about to*
 * go wrong or is fragile: a credential that lapses on the 10th while the nurse is rostered
 * on the 12th (legal today, a violation on publish day + 10), a nurse drifting well past or
 * short of their contract (a payroll and grievance problem, not a rule breach), a week that
 * will be paid at overtime, and a shift staffed exactly at its floor where a single call-off
 * turns a compliant night into a ratio breach. None of these should stop a publish — that is
 * the manager's call — but a publish without seeing them is how a unit finds out on the day.
 *
 * The `overtime` alert has two paths. Given the unit's pricing (`ComplianceInput.cost`) with an
 * active overtime rule, it reports what payroll will pay: `costSchedule` attributes overtime per
 * shift under every basis (daily, seventh day, past the scheduled tour, consecutive hours), which
 * a weekly or pay-period threshold alone never sees. Without one, it falls back to that threshold.
 *
 * Pure over a `ScheduleView` and plain rows so the same pass runs in the publish dialog, the
 * PDF cover sheet and, later, a nightly server job.
 */

import { NURSE_ROLES, type ShiftDemand } from '../acuity/demand.js';
import { costSchedule, isBaylorPlan } from '../cost/cost.js';
import type { CostContext } from '../cost/types.js';
import type {
  Credential,
  FairnessLedgerEntry,
  Holiday,
  HolidayAttribution,
  Id,
  Nurse,
  NurseCredential,
  NurseRole,
  PerDiemCommitment,
} from '../domain/entities.js';
import {
  addDays,
  compareDates,
  DEFAULT_WEEKEND,
  dateInRange,
  daysBetween,
  describeDate,
  formatTimeOfDay,
  type IsoDate,
  WEEKDAY_NAMES,
  type Weekday,
  type WeekendDefinition,
  weekendKey,
} from '../domain/time.js';
import { inLieuHolidayDates } from '../leave/in-lieu.js';
import { credentialLapsedOn } from '../rules/coverage-rules.js';
import {
  type DateWindow,
  judgedSpan,
  type PayCalendar,
  payPeriodIndex,
  payPeriodsIn,
  payPeriodWindow,
  type WindowReading,
  type WorkWeek,
  type WorkWeekSettings,
  windowHours,
  workWeekFor,
  workWeekOf,
  workWeeksIn,
} from '../rules/hours-rules.js';
import { leaveHoursBetween, type PaidLeaveCredit } from '../rules/paid-leave.js';
import { isWorked, nurseName } from '../rules/types.js';
import { nurseWeekends } from '../rules/weekend-pattern.js';
import { attributedHolidayDates } from '../schedule/holiday-attribution.js';
import type { ScheduleView } from '../schedule/view.js';
import { windowBoundaryMinute, windowDayOf } from '../schedule/window-split.js';

export type ComplianceAlertKind =
  | 'credential_expiry'
  | 'hours_drift'
  | 'overtime'
  | 'ratio_risk'
  | 'late_posting'
  | 'per_diem_commitment'
  | 'weekends_off_per_year'
  | 'work_week_changeover'
  | 'start_attribution_underpays'
  | 'in_lieu_holiday';
/** `information` is for things to act on, not to fix: a day that is correct as scheduled. */
export type ComplianceSeverity = 'information' | 'warning' | 'critical';

export interface ComplianceAlert {
  kind: ComplianceAlertKind;
  severity: ComplianceSeverity;
  message: string;
  nurseId?: Id;
  /** For `overtime`, the work week's (or pay period's) start; for `ratio_risk`, the day. */
  date?: IsoDate;
  shiftTypeId?: Id;
  role?: NurseRole;
  /** The shifts this alert is about — what the manager would move to clear it. */
  assignmentIds: Id[];
  /** `hours_drift`: scheduled hours; `overtime`: hours in the week or pay period. */
  hours?: number;
  /** `hours_drift`: contracted hours; `overtime`: the threshold (unset on a priced alert). */
  expectedHours?: number;
  /** `overtime` priced under the unit's overtime rules: the hours payroll will pay as overtime. */
  overtimeHours?: number;
}

export interface ComplianceInput {
  schedule: ScheduleView;
  credentials: readonly Credential[];
  nurseCredentials: readonly NurseCredential[];
  demand: readonly ShiftDemand[];
  /** Weekly hours past which the week is overtime, from the max-hours rule params. */
  overtimeThresholdHours: number;
  workWeekStartsOn: Weekday;
  /**
   * The time that day the work week (and pay period) begins, minutes after midnight, from the
   * max-hours rule. A shift is filed in the week its start falls in. Absent: midnight.
   */
  workWeekStartMinute?: number;
  /**
   * The night nurses' work week, from the max-hours rule (`workWeekFor`): a nurse on permanent
   * nights is alerted on it, and her pay periods start at its minute. Absent: the unit's week.
   */
  nightWorkWeekStartsOn?: Weekday;
  nightWorkWeekStartMinute?: number;
  /**
   * The work-week settings the previous published period was published under, when they put at
   * least one nurse on a different week from these (`work_week_changeover`). Absent: no change.
   */
  previousWorkWeek?: WorkWeekSettings;
  /**
   * The unit's pricing. With at least one active overtime rule of multiplier above 1, `overtime`
   * alerts come from `costSchedule` (daily, seventh-day, consecutive and other bases included)
   * instead of the threshold above; the two never both run, or a weekly 40 rule would alert twice.
   */
  cost?: CostContext;
  /**
   * Present when the max-hours rule judges overtime over the pay period: its threshold, and the
   * unit's pay-period anchor. Overtime is then counted per pay period instead of per week.
   */
  payPeriodOvertime?: { thresholdHours: number; payPeriodAnchor: IsoDate };
  /** Fraction of contracted hours a nurse may drift either way before it is flagged. */
  hoursDriftTolerance: number;
  /**
   * `contractedHoursPerPeriod` is per *pay* period; a schedule period may span several, so
   * the contract is scaled by `periodDays / payPeriodDays` before comparing.
   */
  payPeriodDays: number;
  /** Paid leave by nurse (`RuleContext.paidLeaveByNurse`), counted as the hours rules count it. */
  paidLeaveByNurse?: ReadonlyMap<Id, readonly PaidLeaveCredit[]>;
  /** The contracted-hours rule's setting; paid leave counts toward the contract unless false. */
  paidLeaveCountsTowardHours?: boolean;
  /**
   * The contracted-hours rule's exemptions and standby setting, so drift is judged as the rule
   * judges hours. Absent: per-diem exempt, standby not counted.
   */
  contractedHours?: {
    exemptEmploymentTypes: readonly string[];
    onCallCountsTowardHours: boolean;
  };
  /** The max-hours rule's setting; paid leave counts toward overtime only when true. */
  paidLeaveCountsTowardOvertime?: boolean;
  /**
   * The unit's notice rule and the day the schedule would go out. The caller supplies the date:
   * core never reads the clock. Absent means no check (no notice rule, or already published).
   */
  posting?: { leadDays: number; publishDate: IsoDate };
  /**
   * The unit's per-diem commitment. Absent means no check. The rest of this group feeds it: the
   * rule set's weekend definition, the unit's holidays, and who worked each in earlier periods
   * (`RuleContext.holidayWorkedBy`'s shape).
   */
  perDiemCommitment?: PerDiemCommitment;
  weekendDefinition?: WeekendDefinition;
  holidays?: readonly Holiday[];
  holidayWorkedBy?: ReadonlyMap<Id, ReadonlySet<Id>>;
  /**
   * `Unit.holidayAttribution`: which holiday a night crossing midnight works, so the commitment
   * counts the holidays pay and the ledger count (D18). Absent: the day the shift starts.
   */
  holidayAttribution?: HolidayAttribution;
  /**
   * The unit's promise of weekends off in a year — the 52 weeks ending on the period's last day —
   * and the fairness ledger to count that year's earlier weekends from. Absent means no check.
   * Uses `weekendDefinition` above.
   */
  weekendsOffPerYear?: { minimum: number; ledger: readonly FairnessLedgerEntry[] };
  /**
   * The unit's federal in-lieu-of holidays (`Unit.inLieuHolidays` 'federal'): the holidays to judge,
   * and whether the unit pays holiday premium, which decides what the alert tells the manager the
   * choice is. Absent means no check.
   */
  inLieuHolidays?: { holidays: readonly Holiday[]; premiumPay: boolean };
}

const SEVERITY_ORDER: Record<ComplianceSeverity, number> = {
  critical: 0,
  warning: 1,
  information: 2,
};
const KIND_ORDER: Record<ComplianceAlertKind, number> = {
  credential_expiry: 0,
  ratio_risk: 1,
  overtime: 2,
  work_week_changeover: 3,
  start_attribution_underpays: 4,
  hours_drift: 5,
  late_posting: 6,
  per_diem_commitment: 7,
  weekends_off_per_year: 8,
  in_lieu_holiday: 9,
};

/** How far past the period's end a lapsing credential is still worth a warning. */
const CREDENTIAL_LOOKAHEAD_DAYS = 30;

function credentialExpiry(input: ComplianceInput): ComplianceAlert[] {
  const { schedule } = input;
  const credentialsById = new Map(input.credentials.map((c) => [c.id, c]));
  const alerts: ComplianceAlert[] = [];
  for (const nc of input.nurseCredentials) {
    const credential = credentialsById.get(nc.credentialId);
    const nurse = schedule.nursesById.get(nc.nurseId);
    if (!credential || !nurse || !nc.expiresOn) continue;
    const expiresOn = nc.expiresOn;
    const views = schedule.assignmentsFor(nc.nurseId);
    if (views.length === 0) continue;
    // A card lapsing within a month of the period's end is renewed now or not before the next
    // schedule is built: warn while there is still time to book the class.
    const daysAfter = daysBetween(schedule.period.endDate, expiresOn);
    if (daysAfter > CREDENTIAL_LOOKAHEAD_DAYS) continue;
    if (daysAfter > 0) {
      alerts.push({
        kind: 'credential_expiry',
        severity: 'warning',
        nurseId: nc.nurseId,
        assignmentIds: [],
        message: `${nurseName(nurse)}'s ${credential.code} expires ${describeDate(expiresOn)}, ${daysAfter} day${daysAfter === 1 ? '' : 's'} after this period ends`,
      });
      continue;
    }
    const lapsed = views.filter((v) => credentialLapsedOn(nc, v.assignment.date));
    if (lapsed.length === 0 && compareDates(expiresOn, schedule.period.startDate) < 0) continue;
    alerts.push({
      kind: 'credential_expiry',
      severity: lapsed.length > 0 ? 'critical' : 'warning',
      nurseId: nc.nurseId,
      assignmentIds: lapsed.map((v) => v.assignment.id),
      message:
        lapsed.length > 0
          ? `${nurseName(nurse)}'s ${credential.code} expires ${describeDate(expiresOn)}; ${lapsed.length} shift${lapsed.length === 1 ? '' : 's'} after that date`
          : `${nurseName(nurse)}'s ${credential.code} expires ${describeDate(expiresOn)}, inside this period (no shifts after it)`,
    });
  }
  return alerts;
}

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

const DEFAULT_CONTRACTED_HOURS: NonNullable<ComplianceInput['contractedHours']> = {
  exemptEmploymentTypes: ['per_diem'],
  onCallCountsTowardHours: false,
};

function hoursDrift(input: ComplianceInput): ComplianceAlert[] {
  const { schedule } = input;
  const contract = input.contractedHours ?? DEFAULT_CONTRACTED_HOURS;
  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    // An exempt type has no contracted minimum to drift from, as the contracted-hours rule reads it.
    if (!nurse.active || contract.exemptEmploymentTypes.includes(nurse.employmentType)) continue;
    if (nurse.contractedHoursPerPeriod <= 0) continue;
    const views = schedule
      .assignmentsFor(nurseId)
      .filter((v) => contract.onCallCountsTowardHours || !v.shiftType.isOnCall);
    // Drift is measured against the contract, so scheduled hours: a holdover is overtime, not a
    // roster that ran over the nurse's FTE (as `fte-target-hours` reads it).
    const worked = views.reduce((sum, v) => sum + v.scheduledHours, 0);
    const leave =
      input.paidLeaveCountsTowardHours === false
        ? 0
        : leaveHoursBetween(
            input.paidLeaveByNurse?.get(nurseId),
            schedule.period.startDate,
            schedule.period.endDate,
          );
    const hours = worked + leave;
    const contracted =
      (nurse.contractedHoursPerPeriod * schedule.dates.length) / input.payPeriodDays;
    // As `contracted-hours` reads it: authorised overtime is a deliberate excess, so it is left
    // out of the over side, but a nurse who worked it is not short of those hours.
    const overtime = views.reduce(
      (sum, v) => sum + (v.assignment.isOvertime ? v.scheduledHours : 0),
      0,
    );
    const judged = hours > contracted ? hours - overtime : hours;
    const drift = (judged - contracted) / contracted;
    if (Math.abs(drift) <= input.hoursDriftTolerance) continue;
    const pct = Math.round(drift * 100);
    alerts.push({
      kind: 'hours_drift',
      severity: 'warning',
      nurseId,
      hours,
      expectedHours: contracted,
      assignmentIds: views.map((v) => v.assignment.id),
      message: `${nurseName(nurse)} is scheduled ${oneDecimal(worked)}h${leave > 0 ? ` plus ${oneDecimal(leave)}h paid leave` : ''}${overtime > 0 ? ` (${oneDecimal(overtime)}h of it authorised overtime)` : ''} against ${oneDecimal(contracted)}h contracted (${pct >= 0 ? '+' : ''}${pct}%)`,
    });
  }
  return alerts;
}

/**
 * Each in-period assignment's window-day: the date its start falls on, after the start of its
 * nurse's own week (`workWeekFor`).
 */
function startDayIndex(input: ComplianceInput): Map<Id, IsoDate> {
  return new Map(
    input.schedule.assignments().map((v) => {
      const minute = workWeekFor(v.nurse, input).startMinute;
      return [v.assignment.id, windowDayOf(v.window.startMinute, minute)] as const;
    }),
  );
}

/**
 * The overtime windows a nurse is alerted on: her own work weeks, or the pay periods (the given
 * calendar's dates, her week's start minute), from the one holding the schedule's first instant.
 */
function windowsFor(
  input: ComplianceInput,
  nurse: Nurse,
  payCalendar: PayCalendar | undefined,
): DateWindow[] {
  const { schedule } = input;
  const week = workWeekFor(nurse, input);
  const span = judgedSpan(
    { start: schedule.period.startDate, end: schedule.period.endDate },
    week.startMinute,
  );
  return payCalendar ? payPeriodsIn(span, payCalendar, false) : workWeeksIn(span, week.startsOn);
}

function pricedOvertime(input: ComplianceInput, cost: CostContext): ComplianceAlert[] {
  const { schedule } = input;
  const byPayPeriod = input.payPeriodOvertime;
  // The windows must be the ones `costSchedule` priced over, and that is the cost unit's.
  const payCalendar = byPayPeriod
    ? { payPeriodAnchor: byPayPeriod.payPeriodAnchor, payPeriodDays: cost.unit.payPeriodDays }
    : undefined;
  const span = byPayPeriod ? 'the pay period from' : 'the week of';
  const costs = costSchedule(schedule, cost).assignments;
  // Each shift is filed by the window-day its start falls on, as the cost engine filed it.
  const dayOf = startDayIndex(input);
  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active) continue;
    const windows = windowsFor(input, nurse, payCalendar);
    const mine = costs.filter((c) => c.nurseId === nurseId);
    for (const window of windows) {
      const inWindow = mine.filter((c) => {
        const day = dayOf.get(c.assignmentId) ?? c.date;
        return compareDates(day, window.start) >= 0 && compareDates(day, window.end) <= 0;
      });
      const withOvertime = inWindow.filter((c) => c.overtimeHours > 0);
      if (withOvertime.length === 0) continue;
      const overtimeHours = oneDecimal(inWindow.reduce((n, c) => n + c.overtimeHours, 0));
      const hours = oneDecimal(inWindow.reduce((n, c) => n + c.hours, 0));
      alerts.push({
        kind: 'overtime',
        severity: 'warning',
        nurseId,
        date: window.start,
        hours,
        overtimeHours,
        assignmentIds: withOvertime.map((c) => c.assignmentId),
        message: `${nurseName(nurse)} has ${overtimeHours}h overtime in ${span} ${describeDate(window.start)} (${hours}h), priced under the unit's overtime rules`,
      });
    }
  }
  return alerts;
}

/**
 * How the alerts below read a window's hours: as `max-hours-per-week` reads them under the unit's
 * pay attribution (none without pay settings), against the rule's threshold and paid leave.
 */
function overtimeReader(input: ComplianceInput) {
  const byPayPeriod = input.payPeriodOvertime;
  const payCalendar: PayCalendar | undefined = byPayPeriod
    ? { payPeriodAnchor: byPayPeriod.payPeriodAnchor, payPeriodDays: input.payPeriodDays }
    : undefined;
  const threshold = byPayPeriod ? byPayPeriod.thresholdHours : input.overtimeThresholdHours;
  const tz = input.cost?.dstTransitions ?? [];
  const reading = (attribution: 'clock' | 'start' | undefined): WindowReading => ({
    ...(attribution ? { overtimeWindowAttribution: attribution } : {}),
    dstTransitions: tz,
  });
  const unitAttribution = input.cost
    ? (input.cost.overtimeWindowAttribution ?? 'clock')
    : undefined;
  const timelineOf = (nurseId: Id) =>
    input.schedule.timelineFor(nurseId).filter((v) => !v.shiftType.isOnCall);
  const overtimeIn = (
    nurseId: Id,
    window: DateWindow,
    startMinute: number,
    attribution: 'clock' | 'start' | undefined,
  ) => {
    const found = windowHours(timelineOf(nurseId), window, reading(attribution), startMinute);
    const leave = input.paidLeaveCountsTowardOvertime
      ? leaveHoursBetween(input.paidLeaveByNurse?.get(nurseId), window.start, window.end)
      : 0;
    return { ...found, overtime: Math.max(0, found.hours + leave - threshold) };
  };
  /** The window (week, or pay period on the unit's dates) of `week` holding a date's midnight. */
  const windowAt = (date: IsoDate, week: WorkWeek): DateWindow => {
    const day = windowDayOf(windowBoundaryMinute(date), week.startMinute);
    return payCalendar
      ? payPeriodWindow(payPeriodIndex(day, payCalendar), payCalendar)
      : workWeekOf(day, week.startsOn);
  };
  const span = byPayPeriod ? 'the pay period from' : 'the week of';
  return { payCalendar, unitAttribution, overtimeIn, windowAt, span };
}

/** "Saturday 19:00". */
const weekStartText = (week: WorkWeek) =>
  `${WEEKDAY_NAMES[week.startsOn]} ${formatTimeOfDay(week.startMinute)}`;

/**
 * The week a work-week start changes overlaps the old week, and 29 CFR 778.302 counts the
 * overlapping hours toward whichever week pays the employee more. The app judges every week by the
 * current boundary, so where the old boundary would have found more overtime in the week the
 * change takes effect, payroll is told; the pay estimate itself is not changed.
 */
function workWeekChangeover(input: ComplianceInput): ComplianceAlert[] {
  const previous = input.previousWorkWeek;
  if (previous === undefined) return [];
  const { schedule } = input;
  const reader = overtimeReader(input);
  const first = schedule.period.startDate;
  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active) continue;
    const oldWeek = workWeekFor(nurse, previous);
    const newWeek = workWeekFor(nurse, input);
    if (oldWeek.startsOn === newWeek.startsOn && oldWeek.startMinute === newWeek.startMinute) {
      continue;
    }
    // A pay period keeps its dates and moves only by the minute.
    if (reader.payCalendar && oldWeek.startMinute === newWeek.startMinute) continue;
    const newWindow = reader.windowAt(first, newWeek);
    const oldWindow = reader.windowAt(first, oldWeek);
    const now = reader.overtimeIn(nurseId, newWindow, newWeek.startMinute, reader.unitAttribution);
    const before = reader.overtimeIn(
      nurseId,
      oldWindow,
      oldWeek.startMinute,
      reader.unitAttribution,
    );
    if (before.overtime <= now.overtime) continue;
    alerts.push({
      kind: 'work_week_changeover',
      severity: 'warning',
      nurseId,
      date: newWindow.start,
      overtimeHours: oneDecimal(before.overtime),
      assignmentIds: before.assignmentIds,
      message:
        `The work week changed from ${weekStartText(oldWeek)} to ${weekStartText(newWeek)}. ` +
        `For ${reader.span} ${describeDate(newWindow.start)}, ${nurseName(nurse)} has ` +
        `${oneDecimal(before.overtime)}h of overtime counted the old way and ` +
        `${oneDecimal(now.overtime)}h the new way; payroll owes the greater (29 CFR 778.302).`,
    });
  }
  return alerts;
}

/**
 * Crediting a whole shift to the week it starts in is lawful only as a prepayment that never pays
 * less than counting each hour where it was worked: employees "must always be paid time and
 * one-half … for each hour actually worked over 40 hours in the workweek" (DOL opinion letter
 * FLSA2005-17). Under `'start'`, every judged window where the clock finds more overtime than pay
 * credits is flagged; a surplus in another window does not excuse it, since each week stands alone.
 */
function startAttributionUnderpays(input: ComplianceInput): ComplianceAlert[] {
  if (input.cost?.overtimeWindowAttribution !== 'start') return [];
  const { schedule } = input;
  const reader = overtimeReader(input);
  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active) continue;
    const startMinute = workWeekFor(nurse, input).startMinute;
    for (const window of windowsFor(input, nurse, reader.payCalendar)) {
      const clock = reader.overtimeIn(nurseId, window, startMinute, 'clock');
      if (!clock.touchesPeriod) continue;
      const credited = reader.overtimeIn(nurseId, window, startMinute, 'start');
      const short = clock.overtime - credited.overtime;
      if (short <= 0) continue;
      alerts.push({
        kind: 'start_attribution_underpays',
        severity: 'warning',
        nurseId,
        date: window.start,
        overtimeHours: oneDecimal(clock.overtime),
        assignmentIds: clock.assignmentIds,
        message:
          `Pay credits a night to the week it starts in. Counted by the clock, ${nurseName(nurse)} ` +
          `works ${oneDecimal(clock.overtime)}h of overtime in ${reader.span} ` +
          `${describeDate(window.start)}, ${oneDecimal(short)}h more than pay credits. The Labor ` +
          'Department allows start-week crediting only if it never pays less (opinion letter ' +
          'FLSA2005-17).',
      });
    }
  }
  return alerts;
}

function overtime(input: ComplianceInput): ComplianceAlert[] {
  if (input.cost?.overtimeRules.some((r) => r.active && r.multiplier > 1)) {
    return pricedOvertime(input, input.cost);
  }
  const { schedule } = input;
  const alerts: ComplianceAlert[] = [];
  const byPayPeriod = input.payPeriodOvertime;
  const payCalendar = byPayPeriod
    ? { payPeriodAnchor: byPayPeriod.payPeriodAnchor, payPeriodDays: input.payPeriodDays }
    : undefined;
  const threshold = byPayPeriod ? byPayPeriod.thresholdHours : input.overtimeThresholdHours;
  const span = byPayPeriod ? 'the pay period from' : 'the week of';
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active) continue;
    const weeks = windowsFor(input, nurse, payCalendar);
    const startMinute = workWeekFor(nurse, input).startMinute;
    for (const week of weeks) {
      const inWeek = schedule.timelineFor(nurseId).filter((v) => {
        if (v.shiftType.isOnCall) return false;
        // Filed by its start against the work week's start time (its date at midnight).
        const day = windowDayOf(v.window.startMinute, startMinute);
        return compareDates(day, week.start) >= 0 && compareDates(day, week.end) <= 0;
      });
      // A week this period holds none of the nurse's shifts in was judged with the last schedule,
      // and an alert here would name nothing the manager could move.
      if (!inWeek.some((v) => v.inPeriod)) continue;
      const leave = input.paidLeaveCountsTowardOvertime
        ? leaveHoursBetween(input.paidLeaveByNurse?.get(nurseId), week.start, week.end)
        : 0;
      const hours = inWeek.reduce((sum, v) => sum + v.paidHours, 0) + leave;
      if (hours <= threshold) continue;
      alerts.push({
        kind: 'overtime',
        severity: 'warning',
        nurseId,
        date: week.start,
        hours,
        expectedHours: threshold,
        assignmentIds: inWeek.filter((v) => v.inPeriod).map((v) => v.assignment.id),
        message: `${nurseName(nurse)} has ${hours - threshold}h overtime in ${span} ${describeDate(week.start)} (${hours}h)`,
      });
    }
  }
  return alerts;
}

function ratioRisk(input: ComplianceInput): ComplianceAlert[] {
  const { schedule } = input;
  const alerts: ComplianceAlert[] = [];
  for (const d of input.demand) {
    if (compareDates(d.date, schedule.period.startDate) < 0) continue;
    if (compareDates(d.date, schedule.period.endDate) > 0) continue;
    const patients = d.projectedCensus;
    const details: string[] = [];
    const roles = new Set<NurseRole>();
    for (const role of NURSE_ROLES) {
      const demand = d.byRole[role];
      // Only where a patient ratio sets the minimum. A coverage floor is the unit's own
      // staffing target — the solver fills to it on purpose — and calling every such shift a
      // risk would bury the ones where a call-off makes the shift *illegal*.
      if (demand.bindingConstraint === 'coverage_floor') continue;
      const staffed = schedule.countOnShift(d.date, d.shiftTypeId, role);
      // Below the minimum is a violation the rule engine already reports; exactly at it is
      // the fragile case nothing else names.
      if (staffed !== demand.minCount || demand.minCount <= 0) continue;
      roles.add(role);
      // An RN minimum raised by a pooled rule's share is not a patients-per-RN ratio, and printing
      // it as one ("RN 2 for 20 patients, 1:10") reads as a breach that is not there.
      if (
        d.licensed &&
        demand.minCount === d.licensed.minRn &&
        d.licensed.minRn > demand.ratioDerived
      ) {
        details.push(`RN share ${staffed} of ${d.licensed.ratioDerived} licensed`);
      } else if (demand.ratioBedside > 0) {
        // The ratio is patients per bedside nurse: a charge nurse without patients and break
        // relief are in the minimum but carry no assignment of their own.
        details.push(
          `${role} ${staffed} for ${patients} patients, 1:${Math.ceil(patients / demand.ratioBedside)}`,
        );
      } else {
        details.push(`${role} ${staffed}, the ratio minimum`);
      }
    }
    if (d.licensed) {
      // A shift governed only by a pooled rule is fragile at the pool's count, which no role's
      // own minimum shows.
      const pool =
        schedule.countOnShift(d.date, d.shiftTypeId, 'RN') +
        schedule.countOnShift(d.date, d.shiftTypeId, 'LPN');
      if (pool === d.licensed.ratioDerived) {
        roles.add('RN');
        roles.add('LPN');
        details.push(
          `licensed (RN + LPN) ${pool} for ${patients} patients, 1:${Math.ceil(patients / d.licensed.ratioBedside)}`,
        );
      }
    }
    if (details.length === 0) continue;
    const shiftType = schedule.shiftTypesById.get(d.shiftTypeId);
    const label = shiftType?.abbreviation ?? d.shiftTypeId;
    alerts.push({
      kind: 'ratio_risk',
      severity: 'warning',
      date: d.date,
      shiftTypeId: d.shiftTypeId,
      assignmentIds: schedule
        .onShift(d.date, d.shiftTypeId)
        .filter((v) => roles.has(v.nurse.role))
        .map((v) => v.assignment.id),
      message: `${describeDate(d.date)} ${label} is staffed exactly at the patient ratio (${details.join('; ')}): one call-off breaches it`,
    });
  }
  return alerts;
}

function latePosting(input: ComplianceInput): ComplianceAlert[] {
  if (!input.posting) return [];
  const { leadDays, publishDate } = input.posting;
  // Days of notice staff actually get is the gap to the first day; a day short of the lead is late.
  const notice = daysBetween(publishDate, input.schedule.period.startDate);
  const daysLate = leadDays - notice;
  if (daysLate <= 0) return [];
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  return [
    {
      kind: 'late_posting',
      severity: 'warning',
      assignmentIds: [],
      // Judged before publishing, so it says what publishing now would give staff.
      message: `Publishing on ${describeDate(publishDate)} gives ${notice === 1 ? "1 day's" : `${notice} days'`} notice, ${days(daysLate)} short of the unit's ${leadDays}-day notice`,
    },
  ];
}

/**
 * A per-diem nurse trades guaranteed hours for a minimum availability. It is an alert, not a
 * rule: a hard floor would gate every shift added to an under-committed nurse, and the shortfall
 * is the nurse's to make up, not a breach by the manager.
 */
function perDiemCommitment(input: ComplianceInput): ComplianceAlert[] {
  const commitment = input.perDiemCommitment;
  if (!commitment) return [];
  const { schedule } = input;
  const { startDate, endDate } = schedule.period;
  const weekendDef = input.weekendDefinition ?? DEFAULT_WEEKEND;
  const requiredWeekends = Math.ceil(
    (commitment.weekendShiftsPer4Weeks * schedule.dates.length) / 28,
  );
  const holidays = input.holidays ?? [];
  const attribution = input.holidayAttribution ?? 'start';
  // A year's holiday commitment is judged once, by the period holding that year's last holiday,
  // so every earlier period reads as complete-so-far and none is nagged for a half-finished year.
  const lastOfYear = new Map<string, Holiday>();
  for (const h of holidays) {
    const year = h.date.slice(0, 4);
    const last = lastOfYear.get(year);
    if (!last || compareDates(h.date, last.date) > 0) lastOfYear.set(year, h);
  }
  const judgedYears = [...lastOfYear]
    .filter(([, h]) => dateInRange(h.date, startDate, endDate))
    .map(([year]) => year)
    .sort();

  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active || nurse.employmentType !== 'per_diem') continue;
    const worked = schedule.assignmentsFor(nurseId).filter((v) => !v.shiftType.isOnCall);

    if (requiredWeekends > 0) {
      const weekend = worked.filter((v) => weekendKey(v.window, weekendDef) !== null);
      if (weekend.length < requiredWeekends) {
        alerts.push({
          kind: 'per_diem_commitment',
          severity: 'warning',
          nurseId,
          assignmentIds: weekend.map((v) => v.assignment.id),
          message: `${nurseName(nurse)} has ${weekend.length} weekend shift${weekend.length === 1 ? '' : 's'} in this period against a per-diem commitment of ${requiredWeekends}`,
        });
      }
    }

    if (commitment.holidayShiftsPerYear > 0) {
      for (const year of judgedYears) {
        const ofYear = holidays.filter((h) => h.date.slice(0, 4) === year);
        const done = new Set<Id>();
        for (const h of ofYear) {
          if (dateInRange(h.date, startDate, endDate)) continue;
          if (input.holidayWorkedBy?.get(h.id)?.has(nurseId)) done.add(h.id);
        }
        for (const h of ofYear) {
          const isThis = (d: IsoDate) => d === h.date;
          const onIt = worked.some((v) =>
            attributedHolidayDates(v.assignment.date, v.shiftType, attribution, isThis).includes(
              h.date,
            ),
          );
          if (onIt) done.add(h.id);
        }
        if (done.size >= commitment.holidayShiftsPerYear) continue;
        alerts.push({
          kind: 'per_diem_commitment',
          severity: 'warning',
          nurseId,
          assignmentIds: [],
          message: `${nurseName(nurse)} has worked ${done.size} holiday${done.size === 1 ? '' : 's'} in ${year} against a per-diem commitment of ${commitment.holidayShiftsPerYear}`,
        });
      }
    }
  }
  return alerts;
}

/**
 * A yearly promise of weekends off, judged over the 52 weeks ending on the period's last day: the
 * ledger's periods that began within them, plus this period. `weekend-pattern` sees one schedule;
 * only the ledger knows the rest of the year. The ledger has no period end, so a period that began
 * before the 52 weeks and straddles their start is left out. That, and a new unit's short history,
 * under-count weekends worked, which never raises a false alert.
 */
function weekendsOffPerYear(input: ComplianceInput): ComplianceAlert[] {
  const promise = input.weekendsOffPerYear;
  if (!promise) return [];
  const { schedule } = input;
  const weekendDefinition = input.weekendDefinition ?? DEFAULT_WEEKEND;
  const { startDate, endDate } = schedule.period;
  // 364 days ending on the last day: a year of 52 whole weeks, however long the period.
  const from = addDays(endDate, -363);
  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    // A Baylor nurse (38 U.S.C. § 7456) works every weekend by contract; the promise is not theirs.
    if (isBaylorPlan(nurse)) continue;
    let before = 0;
    for (const e of promise.ledger) {
      if (e.nurseId !== nurseId) continue;
      if (compareDates(e.periodStart, from) >= 0 && compareDates(e.periodStart, startDate) < 0) {
        before += e.weekendsWorked;
      }
    }
    const { inPeriod } = nurseWeekends(schedule, nurseId, { weekendDefinition });
    const worked = before + inPeriod.size;
    const off = 52 - worked;
    if (off >= promise.minimum) continue;
    alerts.push({
      kind: 'weekends_off_per_year',
      severity: 'warning',
      nurseId,
      assignmentIds: schedule
        .assignmentsFor(nurseId)
        .filter((v) => isWorked(v) && weekendKey(v.window, weekendDefinition) !== null)
        .map((v) => v.assignment.id),
      message: `${nurseName(nurse)} would have worked ${worked} weekends in the year to ${describeDate(endDate, { year: true })}, leaving ${off} weekends off against the ${promise.minimum} the unit promises`,
    });
  }
  return alerts;
}

/**
 * A full-time federal nurse's holiday on her day off moves to a day she is scheduled (5 U.S.C.
 * § 6103(b)). That day is correct as scheduled, so this is information: the manager decides
 * whether to give it off or pay or record it.
 */
function inLieuHoliday(input: ComplianceInput): ComplianceAlert[] {
  const { schedule, inLieuHolidays } = input;
  if (!inLieuHolidays) return [];
  const { startDate, endDate } = schedule.period;
  const judged = inLieuHolidays.holidays.filter((h) => dateInRange(h.date, startDate, endDate));
  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active) continue;
    const timeline = schedule.timelineFor(nurseId);
    const dates = inLieuHolidayDates(nurse, timeline, judged);
    for (const holiday of judged) {
      const date = dates.get(holiday.id);
      if (!date) continue;
      const outcome = inLieuHolidays.premiumPay
        ? 'it is paid at the holiday rate'
        : 'record how it is compensated';
      alerts.push({
        kind: 'in_lieu_holiday',
        severity: 'information',
        nurseId,
        date,
        assignmentIds: timeline
          .filter((v) => isWorked(v) && v.assignment.date === date)
          .map((v) => v.assignment.id),
        message: `${nurseName(nurse)}'s in-lieu day for ${holiday.name} is ${describeDate(date)}: give it off, or ${outcome}.`,
      });
    }
  }
  return alerts;
}

/** Every alert for the period, critical first, then by kind, then by date and nurse. */
export function complianceAlerts(input: ComplianceInput): ComplianceAlert[] {
  const alerts = [
    ...credentialExpiry(input),
    ...hoursDrift(input),
    ...overtime(input),
    ...workWeekChangeover(input),
    ...startAttributionUnderpays(input),
    ...ratioRisk(input),
    ...latePosting(input),
    ...perDiemCommitment(input),
    ...weekendsOffPerYear(input),
    ...inLieuHoliday(input),
  ];
  return alerts.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.date && b.date ? compareDates(a.date, b.date) : 0) ||
      (a.nurseId ?? '').localeCompare(b.nurseId ?? ''),
  );
}
