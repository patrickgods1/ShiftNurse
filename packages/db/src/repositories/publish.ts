/**
 * Publication: the draft → published lifecycle, versions, and the post-publish change log.
 *
 * A draft is a proposal the manager can rearrange freely. Publishing turns it into a promise:
 * the assignments as they went out are frozen in a `schedule_version`, the fairness ledger
 * takes the period's burden on the books, and from then on every edit needs a reason and
 * lands in `schedule_change` — the record a nurse or a union rep reads when asking "why did
 * my Saturday move?" Republishing after edits folds those changes into the next version, with
 * the diff computed by core so the version row says in plain numbers what changed.
 *
 * Everything here takes `DbLike` so a publish — version, status, ledger, audit — composes into
 * one `transact()` in the host. A partial publish is worse than a failed one.
 */

import type {
  Assignment,
  Id,
  IsoDate,
  ScheduleChange,
  ScheduleChangeKind,
  ScheduleChangeSource,
  ScheduleDiff,
  SchedulePeriod,
  ScheduleVersion,
} from '@shiftnurse/core';
import { diffAssignments } from '@shiftnurse/core';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toScheduleChange, toScheduleVersion } from '../mappers.js';
import { scheduleChange, schedulePeriod, scheduleVersion } from '../schema.js';
import { type UpsertFairnessLedgerInput, upsertFairnessLedgerEntry } from './ledger.js';
import { getPeriod, listAssignmentsForPeriod } from './schedule.js';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Oldest first: version 1 is what first went out. */
export function listVersions(db: DbLike, periodId: Id): ScheduleVersion[] {
  return db
    .select()
    .from(scheduleVersion)
    .where(eq(scheduleVersion.periodId, periodId))
    .orderBy(asc(scheduleVersion.version))
    .all()
    .map(toScheduleVersion);
}

export function latestVersion(db: DbLike, periodId: Id): ScheduleVersion | undefined {
  const row = db
    .select()
    .from(scheduleVersion)
    .where(eq(scheduleVersion.periodId, periodId))
    .orderBy(desc(scheduleVersion.version))
    .get();
  return row ? toScheduleVersion(row) : undefined;
}

/** What the current assignments would publish as, against the last version that went out. */
export function pendingDiff(db: DbLike, periodId: Id): ScheduleDiff {
  const previous = latestVersion(db, periodId);
  return diffAssignments(previous?.assignments ?? [], listAssignmentsForPeriod(db, periodId));
}

export interface PublishInput {
  periodId: Id;
  /** Required when republishing; the first publication may go out without one. */
  reason?: string;
  /** This period's burden counters, derived by the caller with core's `deriveCounters`. */
  ledger?: readonly UpsertFairnessLedgerInput[];
}

export interface PublishResult {
  period: SchedulePeriod;
  version: ScheduleVersion;
  diff: ScheduleDiff;
  ledgerEntries: number;
}

/**
 * Publish or republish. Refuses an archived period, a republish without a reason, and a
 * republish of an unchanged schedule (a version that differs from the last by nothing would
 * only confuse whoever reads the history).
 */
export function publishSchedule(db: DbLike, input: PublishInput, actor: string): PublishResult {
  const before = getPeriod(db, input.periodId);
  if (!before) throw new Error(`Schedule period ${input.periodId} not found`);
  if (before.status === 'archived') {
    throw new Error(`Schedule period "${before.name}" is archived; it cannot be published`);
  }
  const previous = latestVersion(db, input.periodId);
  const republish = previous !== undefined;
  const reason = input.reason?.trim() || undefined;
  if (republish && !reason) {
    throw new Error(
      'Republishing a schedule requires a reason: staff already hold the last version',
    );
  }
  const assignments = listAssignmentsForPeriod(db, input.periodId);
  const diff = diffAssignments(previous?.assignments ?? [], assignments);
  if (republish && diff.changes.length === 0) {
    throw new Error(`Nothing has changed since version ${previous.version}; nothing to republish`);
  }

  const publishedAt = Date.now();
  const versionRow = {
    id: ids.scheduleVersion(),
    periodId: input.periodId,
    version: (previous?.version ?? 0) + 1,
    publishedAt,
    publishedBy: actor,
    reason: reason ?? null,
    assignments,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
  };
  db.insert(scheduleVersion).values(versionRow).run();
  const version = toScheduleVersion(versionRow);
  recordAudit(db, {
    entityType: 'schedule_version',
    entityId: version.id,
    action: 'publish',
    actor,
    after: {
      periodId: version.periodId,
      version: version.version,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
      affectedNurseIds: diff.affectedNurseIds,
    },
    reason,
    at: publishedAt,
  });

  db.update(schedulePeriod)
    .set({ status: 'published', publishedAt })
    .where(eq(schedulePeriod.id, input.periodId))
    .run();
  const period = getPeriod(db, input.periodId);
  if (!period) throw new Error(`Schedule period ${input.periodId} vanished during publish`);
  recordAudit(db, {
    entityType: 'schedule_period',
    entityId: period.id,
    action: 'publish',
    actor,
    before,
    after: period,
    reason,
    at: publishedAt,
  });

  let ledgerEntries = 0;
  for (const entry of input.ledger ?? []) {
    upsertFairnessLedgerEntry(db, entry, actor);
    ledgerEntries++;
  }
  return { period, version, diff, ledgerEntries };
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

/**
 * Whether an edit to this period must carry a reason. Drafts are free; a published period is
 * a promise, so the reason is mandatory; an archived period is history and refuses edits.
 * Returns the trimmed reason to record, or `undefined` for a draft.
 */
/** Only an archived period is read-only. Every edit checks this — including the ones, like
 * locking a shift, that need no reason and so never reach `requireChangeReason`. */
export function requirePeriodEditable(period: SchedulePeriod): void {
  if (period.status === 'archived') {
    throw new Error(`Schedule period "${period.name}" is archived and cannot be edited`);
  }
}

export function requireChangeReason(period: SchedulePeriod, reason?: string): string | undefined {
  requirePeriodEditable(period);
  if (period.status !== 'published') return undefined;
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw new Error(
      'Editing a published schedule requires a reason. Staff already hold this schedule; the reason is what they and the change log will see.',
    );
  }
  return trimmed;
}

export interface ScheduleChangeInput {
  periodId: Id;
  kind: ScheduleChangeKind;
  source?: ScheduleChangeSource;
  assignmentId: Id;
  nurseId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  before?: Assignment;
  after?: Assignment;
  reason: string;
}

/**
 * Record one post-publish edit. Refuses without a reason (the audit entry is strict too) and
 * refuses on a period that has never been published — an edit to a draft is not a change to
 * anything anyone holds.
 */
export function recordScheduleChange(
  db: DbLike,
  input: ScheduleChangeInput,
  actor: string,
): ScheduleChange {
  const current = latestVersion(db, input.periodId);
  if (!current) {
    throw new Error(`Schedule period ${input.periodId} has never been published; no change log`);
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error('A change to a published schedule requires a reason');
  const at = Date.now();
  const row = {
    id: ids.scheduleChange(),
    periodId: input.periodId,
    version: current.version,
    kind: input.kind,
    source: input.source ?? 'manual',
    nurseId: input.nurseId,
    date: input.date,
    shiftTypeId: input.shiftTypeId,
    assignmentId: input.assignmentId,
    before: input.before ?? null,
    after: input.after ?? null,
    reason,
    actor,
    at,
  };
  db.insert(scheduleChange).values(row).run();
  const created = toScheduleChange(row);
  recordAuditStrict(
    db,
    {
      entityType: 'schedule_change',
      entityId: created.id,
      action: 'update',
      actor,
      before: input.before,
      after: input.after,
      reason,
      at,
    },
    { requireReason: true },
  );
  return created;
}

/** Newest first — the change log reads from the latest edit down. */
export function listChanges(db: DbLike, periodId: Id): ScheduleChange[] {
  return db
    .select()
    .from(scheduleChange)
    .where(eq(scheduleChange.periodId, periodId))
    .orderBy(desc(scheduleChange.at), desc(sql`rowid`))
    .all()
    .map(toScheduleChange);
}

/** Edits made after the last publication: what a republish would carry to staff. */
export function changesSinceLastPublish(db: DbLike, periodId: Id): ScheduleChange[] {
  const current = latestVersion(db, periodId);
  if (!current) return [];
  return db
    .select()
    .from(scheduleChange)
    .where(
      and(eq(scheduleChange.periodId, periodId), gt(scheduleChange.at, current.publishedAt - 1)),
    )
    .orderBy(desc(scheduleChange.at), desc(sql`rowid`))
    .all()
    .map(toScheduleChange)
    .filter((c) => c.version === current.version);
}
