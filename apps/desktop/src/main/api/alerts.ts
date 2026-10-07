/**
 * Compliance alerts for a period's schedule: the draft on the grid, or a Generate variation being
 * previewed in its place. Kept apart from `publish.ts`, which reaches Electron for the
 * post-publish backup, so the solver's preview can judge a variation the way the publish dialog
 * will — and still run under plain Node in tests.
 */

import {
  type ComplianceAlert,
  type ContractedHoursParams,
  complianceAlerts,
  contractedHoursRule,
  dateInRange,
  datesInRange,
  deriveDemand,
  type Holiday,
  type Id,
  type MaxHoursParams,
  maxHoursRule,
  type PaidLeaveCredit,
  paidLeaveCredits,
  type RuleSet,
  resolveConfigs,
  type SchedulePeriod,
  type ScheduleView,
  today,
} from '@shiftnurse/core';
import {
  type DbLike,
  demandInputs,
  holidayWorkFor,
  listCredentials,
  listHolidaysForUnit,
  listNurseCredentialsForUnit,
  paidSickCallsForUnit,
  timeOffForPeriod,
} from '@shiftnurse/db';
import { periodOrThrow, ruleSetFor, scheduleViewFor, unitOrThrow } from './context.js';

/** How far a nurse may drift from contracted hours before the publish preview flags it. */
const HOURS_DRIFT_TOLERANCE = 0.1;

/**
 * Who worked each holiday of the unit, for the per-diem commitment's holiday half. Not
 * `holidayWorkForPeriod`: that reads last year's occurrences for the rotation, while a calendar
 * year's commitment needs this year's earlier holidays, wherever they fall.
 */
function holidayWorkedBy(
  db: DbLike,
  period: SchedulePeriod,
  holidays: readonly Holiday[],
): Map<Id, Set<Id>> {
  const earlier = holidays
    .filter((h) => !dateInRange(h.date, period.startDate, period.endDate))
    .map((h) => h.id);
  const workedBy = new Map<Id, Set<Id>>();
  for (const r of holidayWorkFor(db, period.unitId, earlier)) {
    const set = workedBy.get(r.holidayId);
    if (set) set.add(r.nurseId);
    else workedBy.set(r.holidayId, new Set([r.nurseId]));
  }
  return workedBy;
}

export function alertsForView(
  db: DbLike,
  period: SchedulePeriod,
  ruleSet: RuleSet,
  schedule: ScheduleView,
): ComplianceAlert[] {
  const configs = resolveConfigs(ruleSet);
  const params = configs.find((c) => c.ruleId === maxHoursRule.id)!
    .params as unknown as MaxHoursParams;
  const fte = configs.find((c) => c.ruleId === contractedHoursRule.id)!
    .params as unknown as ContractedHoursParams;
  const unit = unitOrThrow(db, period.unitId);
  // Paid leave counts as the hours rules count it, so a nurse back from vacation is not "drift".
  const paidLeaveByNurse = new Map<Id, PaidLeaveCredit[]>();
  const credits = paidLeaveCredits(
    timeOffForPeriod(db, unit, period),
    paidSickCallsForUnit(db, period.unitId, { start: period.startDate, end: period.endDate }),
  );
  for (const c of credits) {
    paidLeaveByNurse.set(c.nurseId, [...(paidLeaveByNurse.get(c.nurseId) ?? []), c]);
  }
  // Only an unpublished period is still to be posted; a published one was posted when it was
  // published, and judging it by today's date would call every old schedule late.
  const posting =
    unit.postingLeadDays !== undefined && period.status === 'draft'
      ? { leadDays: unit.postingLeadDays, publishDate: today() }
      : undefined;
  const holidays = unit.perDiemCommitment ? listHolidaysForUnit(db, period.unitId) : [];
  return complianceAlerts({
    ...(posting ? { posting } : {}),
    ...(unit.perDiemCommitment
      ? {
          perDiemCommitment: unit.perDiemCommitment,
          weekendDefinition: ruleSet.weekendDefinition,
          holidays,
          holidayWorkedBy: holidayWorkedBy(db, period, holidays),
        }
      : {}),
    paidLeaveByNurse,
    paidLeaveCountsTowardHours: fte.paidLeaveCountsTowardHours,
    paidLeaveCountsTowardOvertime: params.paidLeaveCountsTowardOvertime,
    schedule,
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, period.unitId),
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, period.unitId, period.startDate, period.endDate),
    ).all(),
    overtimeThresholdHours: params.overtimeThresholdHours,
    workWeekStartsOn: params.workWeekStartsOn,
    ...(params.overtimeByPayPeriod
      ? {
          payPeriodOvertime: {
            thresholdHours: params.payPeriodOvertimeThresholdHours,
            payPeriodAnchor: unit.payPeriodAnchor,
          },
        }
      : {}),
    hoursDriftTolerance: HOURS_DRIFT_TOLERANCE,
    payPeriodDays: unit.payPeriodDays,
  });
}

export function alertsFor(db: DbLike, periodId: Id): ComplianceAlert[] {
  const period = periodOrThrow(db, periodId);
  const schedule = scheduleViewFor(db, period, { lookback: true });
  return alertsForView(db, period, ruleSetFor(db, period), schedule);
}
