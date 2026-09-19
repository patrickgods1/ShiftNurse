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
import type { Credential, Id, NurseCredential, NurseRole } from '../domain/entities.js';
import { compareDates, type IsoDate, type Weekday } from '../domain/time.js';
import { workWeeksIn } from '../rules/hours-rules.js';
import { nurseName } from '../rules/types.js';
import type { ScheduleView } from '../schedule/view.js';

export type ComplianceAlertKind = 'credential_expiry' | 'hours_drift' | 'overtime' | 'ratio_risk';
export type ComplianceSeverity = 'warning' | 'critical';

export interface ComplianceAlert {
  kind: ComplianceAlertKind;
  severity: ComplianceSeverity;
  message: string;
  nurseId?: Id;
  /** For `overtime`, the work week's start; for `ratio_risk`, the day. */
  date?: IsoDate;
  shiftTypeId?: Id;
  role?: NurseRole;
  /** The shifts this alert is about — what the manager would move to clear it. */
  assignmentIds: Id[];
  /** `hours_drift`: scheduled hours; `overtime`: hours in the week. */
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
  /** Fraction of contracted hours a nurse may drift either way before it is flagged. */
  hoursDriftTolerance: number;
  /**
   * `contractedHoursPerPeriod` is per *pay* period; a schedule period may span several, so
   * the contract is scaled by `periodDays / payPeriodDays` before comparing.
   */
  payPeriodDays: number;
}

const SEVERITY_ORDER: Record<ComplianceSeverity, number> = { critical: 0, warning: 1 };
const KIND_ORDER: Record<ComplianceAlertKind, number> = {
  credential_expiry: 0,
  ratio_risk: 1,
  overtime: 2,
  hours_drift: 3,
};

function credentialExpiry(input: ComplianceInput): ComplianceAlert[] {
  const { schedule } = input;
  const credentialsById = new Map(input.credentials.map((c) => [c.id, c]));
  const alerts: ComplianceAlert[] = [];
  for (const nc of input.nurseCredentials) {
    const credential = credentialsById.get(nc.credentialId);
    const nurse = schedule.nursesById.get(nc.nurseId);
    if (!credential || !nurse || !nc.expiresOn) continue;
    if (compareDates(nc.expiresOn, schedule.period.endDate) > 0) continue;
    const views = schedule.assignmentsFor(nc.nurseId);
    if (views.length === 0) continue;
    const expiresOn = nc.expiresOn;
    // A shift *on* the expiry date is already past it: expiry is the last valid day's end.
    const lapsed = views.filter((v) => compareDates(v.assignment.date, expiresOn) >= 0);
    if (lapsed.length === 0 && compareDates(expiresOn, schedule.period.startDate) < 0) continue;
    alerts.push({
      kind: 'credential_expiry',
      severity: lapsed.length > 0 ? 'critical' : 'warning',
      nurseId: nc.nurseId,
      assignmentIds: lapsed.map((v) => v.assignment.id),
      message:
        lapsed.length > 0
          ? `${nurseName(nurse)}'s ${credential.code} expires ${expiresOn}; ${lapsed.length} shift${lapsed.length === 1 ? '' : 's'} on or after that date`
          : `${nurseName(nurse)}'s ${credential.code} expires ${expiresOn}, inside this period (no shifts after it)`,
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
    const hours = views.reduce((sum, v) => sum + v.paidHours, 0);
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
      message: `${nurseName(nurse)} is scheduled ${hours}h against ${contracted}h contracted (${pct >= 0 ? '+' : ''}${pct}%)`,
    });
  }
  return alerts;
}

function overtime(input: ComplianceInput): ComplianceAlert[] {
  const { schedule } = input;
  const alerts: ComplianceAlert[] = [];
  const weeks = workWeeksIn(
    { start: schedule.period.startDate, end: schedule.period.endDate },
    input.workWeekStartsOn,
  );
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
      const hours = inWeek.reduce((sum, v) => sum + v.paidHours, 0);
      if (hours <= input.overtimeThresholdHours) continue;
      alerts.push({
        kind: 'overtime',
        severity: 'warning',
        nurseId,
        date: week.start,
        hours,
        expectedHours: input.overtimeThresholdHours,
        assignmentIds: inWeek.filter((v) => v.inPeriod).map((v) => v.assignment.id),
        message: `${nurseName(nurse)} has ${hours - input.overtimeThresholdHours}h overtime in the week of ${week.start} (${hours}h)`,
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
      message: `${d.date} ${label} is staffed exactly at the patient ratio (${detail}): one call-off breaches it`,
    });
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
  ];
  return alerts.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.date && b.date ? compareDates(a.date, b.date) : 0) ||
      (a.nurseId ?? '').localeCompare(b.nurseId ?? ''),
  );
}
