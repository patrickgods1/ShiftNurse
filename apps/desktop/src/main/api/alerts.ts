/**
 * Compliance alerts for a period's schedule: the draft on the grid, or a Generate variation being
 * previewed in its place. Kept apart from `publish.ts`, which reaches Electron for the
 * post-publish backup, so the solver's preview can judge a variation the way the publish dialog
 * will — and still run under plain Node in tests.
 */

import {
  type ComplianceAlert,
  type ContractedHoursParams,
  compareDates,
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
  type WorkWeekSettings,
  workWeekFor,
} from '@shiftnurse/core';
import {
  costContext,
  type DbLike,
  demandInputs,
  holidayWorkFor,
  ledgerHistory,
  listCredentials,
  listHolidaysForUnit,
  listPeriodsForUnit,
  perNurseRecordsFor,
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

/** The max-hours rule's work-week settings, night week only where the rule set gives one. */
function workWeekSettingsOf(params: MaxHoursParams): WorkWeekSettings {
  return {
    workWeekStartsOn: params.workWeekStartsOn,
    workWeekStartMinute: params.workWeekStartMinute ?? 0,
    ...(params.nightWorkWeekStartsOn !== undefined
      ? { nightWorkWeekStartsOn: params.nightWorkWeekStartsOn }
      : {}),
    ...(params.nightWorkWeekStartMinute !== undefined
      ? { nightWorkWeekStartMinute: params.nightWorkWeekStartMinute }
      : {}),
  };
}

/**
 * The work week the previous published schedule (the one whose shifts open this one's weeks) was
 * published under, when it puts any nurse on this schedule on a different week: the week the
 * change takes effect overlaps the old one (29 CFR 778.302). Read from that period's own rule-set
 * snapshot, never "latest".
 */
export function previousWorkWeekFor(
  db: DbLike,
  period: SchedulePeriod,
  current: WorkWeekSettings,
  schedule: ScheduleView,
): WorkWeekSettings | undefined {
  // Newest first, so the first match is the latest one ending before this period.
  const previous = listPeriodsForUnit(db, period.unitId).find(
    (p) =>
      p.id !== period.id && p.status !== 'draft' && compareDates(p.endDate, period.startDate) < 0,
  );
  if (previous === undefined) return undefined;
  const params = resolveConfigs(ruleSetFor(db, previous)).find((c) => c.ruleId === maxHoursRule.id)!
    .params as unknown as MaxHoursParams;
  const before = workWeekSettingsOf(params);
  const moved = [...schedule.nursesById.values()].some((nurse) => {
    const was = workWeekFor(nurse, before);
    const now = workWeekFor(nurse, current);
    return was.startsOn !== now.startsOn || was.startMinute !== now.startMinute;
  });
  return moved ? before : undefined;
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
  // Whoever is on this schedule, floats included, with their own credentials and leave.
  const records = perNurseRecordsFor(db, unit, period, [...schedule.nursesById.values()]);
  // Paid leave counts as the hours rules count it, so a nurse back from vacation is not "drift".
  const paidLeaveByNurse = new Map<Id, PaidLeaveCredit[]>();
  const credits = paidLeaveCredits(
    records.timeOff,
    records.paidSickCalls.filter((c) => dateInRange(c.date, period.startDate, period.endDate)),
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
  const previousWorkWeek = previousWorkWeekFor(db, period, workWeekSettingsOf(params), schedule);
  return complianceAlerts({
    ...(previousWorkWeek ? { previousWorkWeek } : {}),
    ...(posting ? { posting } : {}),
    ...(unit.perDiemCommitment
      ? {
          perDiemCommitment: unit.perDiemCommitment,
          holidays,
          holidayWorkedBy: holidayWorkedBy(db, period, holidays),
          ...(unit.holidayAttribution ? { holidayAttribution: unit.holidayAttribution } : {}),
        }
      : {}),
    ...(unit.minWeekendsOffPerYear !== undefined
      ? {
          weekendsOffPerYear: {
            minimum: unit.minWeekendsOffPerYear,
            ledger: ledgerHistory(db, unit.id, period.startDate),
          },
        }
      : {}),
    ...(unit.perDiemCommitment || unit.minWeekendsOffPerYear !== undefined
      ? { weekendDefinition: ruleSet.weekendDefinition }
      : {}),
    paidLeaveByNurse,
    paidLeaveCountsTowardHours: fte.paidLeaveCountsTowardHours,
    contractedHours: {
      exemptEmploymentTypes: fte.exemptEmploymentTypes,
      onCallCountsTowardHours: fte.onCallCountsTowardHours,
    },
    paidLeaveCountsTowardOvertime: params.paidLeaveCountsTowardOvertime,
    schedule,
    cost: costContext(db, period.unitId, ruleSet, period),
    credentials: listCredentials(db),
    nurseCredentials: records.nurseCredentials,
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, period.unitId, period.startDate, period.endDate),
    ).all(),
    overtimeThresholdHours: params.overtimeThresholdHours,
    workWeekStartsOn: params.workWeekStartsOn,
    workWeekStartMinute: params.workWeekStartMinute ?? 0,
    ...(params.nightWorkWeekStartsOn !== undefined
      ? { nightWorkWeekStartsOn: params.nightWorkWeekStartsOn }
      : {}),
    ...(params.nightWorkWeekStartMinute !== undefined
      ? { nightWorkWeekStartMinute: params.nightWorkWeekStartMinute }
      : {}),
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
  const schedule = scheduleViewFor(db, period, { lookback: true, floated: 'worked' });
  return alertsForView(db, period, ruleSetFor(db, period), schedule);
}
