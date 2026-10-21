/**
 * Publishing: the preview (diff, validation, compliance alerts), the publish itself, and the
 * input every export renders from. The preview and exports build the period's view once and hand
 * it to validation and alerts, which used to load and index the same rows twice per call.
 */

import type { Id } from '@shiftnurse/core';
import {
  changesSinceLastPublish,
  type DbLike,
  latestVersion,
  listChanges,
  listVersions,
  pendingDiff,
  periodLedgerRows,
  publishSchedule,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import type { PublishOutcome, PublishPreview, ShiftNurseApi } from '../../shared/api.js';
import { createBackup } from '../backups.js';
import type { OutputInput } from '../output.js';
import { alertsFor, alertsForView } from './alerts.js';
import {
  ACTOR,
  counterContext,
  periodOrThrow,
  ruleSetFor,
  scheduleViewFor,
  unitOrThrow,
} from './context.js';
import { validateView } from './schedule.js';

export { alertsFor };

export function publishPreview(db: DbLike, periodId: Id): PublishPreview {
  const period = periodOrThrow(db, periodId);
  const ruleSet = ruleSetFor(db, period);
  // Two views of one schedule (D20): rules judge a floated-off shift as busy time, alerts count it.
  const schedule = scheduleViewFor(db, period, { lookback: true, floated: 'worked' });
  const latest = latestVersion(db, periodId);
  const diff = pendingDiff(db, periodId);
  const { result } = validateView(
    db,
    period,
    scheduleViewFor(db, period, { lookback: true, floated: 'busy' }),
  );
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
  acknowledged?: number,
): Promise<PublishOutcome> {
  const committed = transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    // Counted again here, by the verdict the preview used: the count she reviewed may be stale,
    // and a schedule that goes out broken must carry her reason on the record.
    const judged = validateView(
      tx,
      period,
      scheduleViewFor(tx, period, { lookback: true, floated: 'busy' }),
    );
    const count = judged.result.hardViolations.length;
    const s = count === 1 ? '' : 's';
    if (count > 0 && acknowledged !== count) {
      throw new Error(
        acknowledged === undefined
          ? `This schedule breaks ${count} hard rule${s}. Review them and confirm before publishing.`
          : `The schedule now has ${count} rule break${s}, not the ${acknowledged} you reviewed. Look at the publish summary again.`,
      );
    }
    const codes = [...new Set(judged.result.hardViolations.map((v) => v.code))].sort();
    const ruleSet = ruleSetFor(tx, period);
    // No lookback: the ledger records what this period scheduled.
    const schedule = scheduleViewFor(tx, period, { lookback: false, floated: 'worked' });
    // The ledger is core's counters for what was actually scheduled: the same `periodLedgerRows`
    // the history importer and the seeds book through, so all of them agree on a weekend.
    const ledger = periodLedgerRows(schedule, counterContext(tx, period.unitId, ruleSet, period), {
      includeAvailableHomeNurses: true,
    });
    return publishSchedule(
      tx,
      { periodId, reason, ledger, hardViolations: { count, codes } },
      ACTOR,
    );
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
  const schedule = scheduleViewFor(db, period, { lookback: true, floated: 'worked' });
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

export function publishApi(db: ShiftNurseDb): ShiftNurseApi['publish'] {
  return {
    preview: (periodId) => publishPreview(db, periodId),
    publish: (periodId, reason, acknowledged) => publish(db, periodId, reason, acknowledged),
    versions: (periodId) => listVersions(db, periodId),
    changes: (periodId) => listChanges(db, periodId),
    alerts: (periodId) => alertsFor(db, periodId),
  };
}
