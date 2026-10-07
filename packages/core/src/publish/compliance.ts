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
 * Pure over a `ScheduleView` and plain rows so the same pass runs in the publish dialog, the
 * PDF cover sheet and, later, a nightly server job.
 */

import { NURSE_ROLES, type ShiftDemand } from '../acuity/demand.js';
import type {
  Credential,
  Holiday,
  Id,
  NurseCredential,
  NurseRole,
  PerDiemCommitment,
} from '../domain/entities.js';
import {
  compareDates,
  DEFAULT_WEEKEND,
  dateInRange,
  daysBetween,
  describeDate,
  type IsoDate,
  type Weekday,
  type WeekendDefinition,
  weekendKey,
} from '../domain/time.js';
import { credentialLapsedOn } from '../rules/coverage-rules.js';
import { payPeriodsIn, workWeeksIn } from '../rules/hours-rules.js';
import { leaveHoursBetween, type PaidLeaveCredit } from '../rules/paid-leave.js';
import { nurseName } from '../rules/types.js';
import type { ScheduleView } from '../schedule/view.js';

export type ComplianceAlertKind =
  | 'credential_expiry'
  | 'hours_drift'
  | 'overtime'
  | 'ratio_risk'
  | 'late_posting'
  | 'per_diem_commitment';
export type ComplianceSeverity = 'warning' | 'critical';

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
  /** `hours_drift`: contracted hours; `overtime`: the threshold. */
  expectedHours?: number;
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
}

const SEVERITY_ORDER: Record<ComplianceSeverity, number> = { critical: 0, warning: 1 };
const KIND_ORDER: Record<ComplianceAlertKind, number> = {
  credential_expiry: 0,
  ratio_risk: 1,
  overtime: 2,
  hours_drift: 3,
  late_posting: 4,
  per_diem_commitment: 5,
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

function hoursDrift(input: ComplianceInput): ComplianceAlert[] {
  const { schedule } = input;
  const alerts: ComplianceAlert[] = [];
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active || nurse.employmentType === 'per_diem') continue;
    if (nurse.contractedHoursPerPeriod <= 0) continue;
    const views = schedule.assignmentsFor(nurseId).filter((v) => !v.shiftType.isOnCall);
    const worked = views.reduce((sum, v) => sum + v.paidHours, 0);
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
    const drift = (hours - contracted) / contracted;
    if (Math.abs(drift) <= input.hoursDriftTolerance) continue;
    const pct = Math.round(drift * 100);
    alerts.push({
      kind: 'hours_drift',
      severity: 'warning',
      nurseId,
      hours,
      expectedHours: contracted,
      assignmentIds: views.map((v) => v.assignment.id),
      message: `${nurseName(nurse)} is scheduled ${worked}h${leave > 0 ? ` plus ${Math.round(leave * 10) / 10}h paid leave` : ''} against ${contracted}h contracted (${pct >= 0 ? '+' : ''}${pct}%)`,
    });
  }
  return alerts;
}

function overtime(input: ComplianceInput): ComplianceAlert[] {
  const { schedule } = input;
  const alerts: ComplianceAlert[] = [];
  const window = { start: schedule.period.startDate, end: schedule.period.endDate };
  const byPayPeriod = input.payPeriodOvertime;
  const weeks = byPayPeriod
    ? payPeriodsIn(
        window,
        { payPeriodAnchor: byPayPeriod.payPeriodAnchor, payPeriodDays: input.payPeriodDays },
        false,
      )
    : workWeeksIn(window, input.workWeekStartsOn);
  const threshold = byPayPeriod ? byPayPeriod.thresholdHours : input.overtimeThresholdHours;
  const span = byPayPeriod ? 'the pay period from' : 'the week of';
  for (const [nurseId, nurse] of schedule.nursesById) {
    if (!nurse.active) continue;
    for (const week of weeks) {
      const inWeek = schedule
        .timelineFor(nurseId)
        .filter(
          (v) =>
            !v.shiftType.isOnCall &&
            compareDates(v.assignment.date, week.start) >= 0 &&
            compareDates(v.assignment.date, week.end) <= 0,
        );
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
    const atRatio: { role: NurseRole; nurses: number; patients: number }[] = [];
    for (const role of NURSE_ROLES) {
      const demand = d.byRole[role];
      // Only where a patient ratio sets the minimum. A coverage floor is the unit's own
      // staffing target — the solver fills to it on purpose — and calling every such shift a
      // risk would bury the ones where a call-off makes the shift *illegal*.
      if (demand.bindingConstraint === 'coverage_floor' || demand.ratioDerived <= 0) continue;
      const staffed = schedule.countOnShift(d.date, d.shiftTypeId, role);
      // Below the minimum is a violation the rule engine already reports; exactly at it is
      // the fragile case nothing else names.
      if (staffed === demand.minCount) {
        atRatio.push({ role, nurses: staffed, patients: d.projectedCensus });
      }
    }
    if (atRatio.length === 0) continue;
    const shiftType = schedule.shiftTypesById.get(d.shiftTypeId);
    const label = shiftType?.abbreviation ?? d.shiftTypeId;
    const detail = atRatio
      .map(
        (r) =>
          `${r.role} ${r.nurses} for ${r.patients} patients, 1:${Math.ceil(r.patients / r.nurses)}`,
      )
      .join('; ');
    alerts.push({
      kind: 'ratio_risk',
      severity: 'warning',
      date: d.date,
      shiftTypeId: d.shiftTypeId,
      assignmentIds: schedule
        .onShift(d.date, d.shiftTypeId)
        .filter((v) => atRatio.some((r) => r.role === v.nurse.role))
        .map((v) => v.assignment.id),
      message: `${describeDate(d.date)} ${label} is staffed exactly at the patient ratio (${detail}): one call-off breaches it`,
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
          if (worked.some((v) => v.assignment.date === h.date)) done.add(h.id);
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

/** Every alert for the period, critical first, then by kind, then by date and nurse. */
export function complianceAlerts(input: ComplianceInput): ComplianceAlert[] {
  const alerts = [
    ...credentialExpiry(input),
    ...hoursDrift(input),
    ...overtime(input),
    ...ratioRisk(input),
    ...latePosting(input),
    ...perDiemCommitment(input),
  ];
  return alerts.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.date && b.date ? compareDates(a.date, b.date) : 0) ||
      (a.nurseId ?? '').localeCompare(b.nurseId ?? ''),
  );
}
