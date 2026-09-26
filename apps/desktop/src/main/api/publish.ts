/**
 * Publishing: the preview (diff, validation, compliance alerts), the publish itself, and the
 * input every export renders from. The preview and exports build the period's view once and hand
 * it to validation and alerts, which used to load and index the same rows twice per call.
 */

import {
  type ComplianceAlert,
  complianceAlerts,
  datesInRange,
  deriveCounters,
  deriveDemand,
  type Id,
  type MaxHoursParams,
  maxHoursRule,
  type RuleSet,
  type SchedulePeriod,
  type ScheduleView,
} from '@shiftnurse/core';
import {
  changesSinceLastPublish,
  type DbLike,
  demandInputs,
  latestVersion,
  listCredentials,
  listNurseCredentialsForUnit,
  pendingDiff,
  publishSchedule,
  type ShiftNurseDb,
  transact,
  type UpsertFairnessLedgerInput,
} from '@shiftnurse/db';
import type { PublishOutcome, PublishPreview } from '../../shared/api.js';
import { createBackup } from '../backups.js';
import type { OutputInput } from '../output.js';

import {
  ACTOR,
  counterContext,
  periodOrThrow,
  ruleSetFor,
  scheduleViewFor,
  unitOrThrow,
} from './context.js';
import { validateView } from './schedule.js';

/** How far a nurse may drift from contracted hours before the publish preview flags it. */
const HOURS_DRIFT_TOLERANCE = 0.1;

function alertsForView(
  db: DbLike,
  period: SchedulePeriod,
  ruleSet: RuleSet,
  schedule: ScheduleView,
): ComplianceAlert[] {
  const maxHours = ruleSet.configs.find((c) => c.ruleId === maxHoursRule.id);
  const params = { ...maxHoursRule.defaultParams, ...(maxHours?.params ?? {}) } as MaxHoursParams;
  return complianceAlerts({
    schedule,
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, period.unitId),
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, period.unitId, period.startDate, period.endDate),
    ).all(),
    overtimeThresholdHours: params.overtimeThresholdHours,
    workWeekStartsOn: params.workWeekStartsOn,
    hoursDriftTolerance: HOURS_DRIFT_TOLERANCE,
    payPeriodDays: unitOrThrow(db, period.unitId).payPeriodDays,
  });
}

export function alertsFor(db: DbLike, periodId: Id): ComplianceAlert[] {
  const period = periodOrThrow(db, periodId);
  const schedule = scheduleViewFor(db, period, { lookback: true });
  return alertsForView(db, period, ruleSetFor(db, period), schedule);
}

export function publishPreview(db: DbLike, periodId: Id): PublishPreview {
  const period = periodOrThrow(db, periodId);
  const ruleSet = ruleSetFor(db, period);
  const schedule = scheduleViewFor(db, period, { lookback: true });
  const latest = latestVersion(db, periodId);
  const diff = pendingDiff(db, periodId);
  const { result } = validateView(db, period, ruleSet, schedule);
  return {
    period,
    latestVersion: latest,
    diff,
    pendingChanges: changesSinceLastPublish(db, periodId),
    alerts: alertsForView(db, period, ruleSet, schedule),
    hardViolations: result.hardViolations.length,
    softViolations: result.softViolations.length,
    nothingToPublish: latest !== undefined && diff.changes.length === 0,
  };
}

/**
 * Version, status, ledger and audit in one transaction; then the backup. The backup comes
 * after the commit on purpose — a backup of a database that then rolled back would be a
 * copy of a schedule nobody published — and a backup failure is reported, not fatal: the
 * publish itself has already happened and must not be reported as failed.
 */
export async function publish(
  db: ShiftNurseDb,
  periodId: Id,
  reason?: string,
): Promise<PublishOutcome> {
  const committed = transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    const ruleSet = ruleSetFor(tx, period);
    // No lookback: the ledger records what this period scheduled.
    const schedule = scheduleViewFor(tx, period, { lookback: false });
    // The ledger takes what was actually scheduled, derived by the same `deriveCounters`
    // that scores fairness and imports history, so all three agree on what a weekend is.
    const present = new Set(schedule.assignments().map((v) => v.nurse.id));
    const ledger: UpsertFairnessLedgerInput[] = [];
    for (const [nurseId, counters] of deriveCounters(
      schedule,
      counterContext(tx, period.unitId, ruleSet),
    )) {
      if (!present.has(nurseId)) continue;
      ledger.push({ nurseId, periodId, periodStart: period.startDate, ...counters });
    }
    return publishSchedule(tx, { periodId, reason, ledger }, ACTOR);
  });
  let backup: PublishOutcome['backup'];
  try {
    backup = await createBackup(
      db,
      'publish',
      `${committed.period.name}-v${committed.version.version}`,
    );
  } catch (err) {
    console.error(`[backup] publish backup failed: ${err instanceof Error ? err.message : err}`);
  }
  return { ...committed, backup };
}

/** Exported for the smoke test, which renders a real PDF in main without a save dialog. */
export function outputInput(db: DbLike, periodId: Id): OutputInput {
  const period = periodOrThrow(db, periodId);
  const schedule = scheduleViewFor(db, period, { lookback: true });
  return {
    schedule,
    ctx: {
      unit: unitOrThrow(db, period.unitId),
      version: latestVersion(db, periodId),
      status: period.status,
      alerts: alertsForView(db, period, ruleSetFor(db, period), schedule),
    },
  };
}
