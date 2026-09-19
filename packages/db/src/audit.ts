/**
 * The audit trail.
 *
 * Every mutation goes through here. This is the table that answers "why does the schedule say
 * that?" months later, in front of a union representative — so it is append-only, it records
 * both the before and after state, and it carries the manager's stated reason verbatim rather
 * than a paraphrase.
 *
 * Writing an audit entry is never optional and never conditional on success elsewhere: audit
 * writes happen inside the same transaction as the change they describe, so a rolled-back
 * change leaves no misleading audit entry and a committed change can never lack one.
 */

import type { AuditAction, AuditLogEntry, Id } from '@shiftnurse/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbLike } from './client.js';
import { ids } from './ids.js';
import { auditLog } from './schema.js';

export interface AuditInput {
  entityType: string;
  entityId: Id;
  action: AuditAction;
  /** Who did it. v1 is single-user, so this is the manager; kept for the multi-user future. */
  actor: string;
  before?: unknown;
  after?: unknown;
  /** Required by convention for `deny`, `resolve`, `auto_resolve` and any override. */
  reason?: string;
  at?: number;
}

/** Record one change. Call inside the same transaction as the change itself. */
export function recordAudit(db: DbLike, input: AuditInput): Id {
  const id = ids.audit();
  db.insert(auditLog)
    .values({
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actor: input.actor,
      at: input.at ?? Date.now(),
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.reason ?? null,
    })
    .run();
  return id;
}

/**
 * Actions whose audit entry is meaningless without a stated reason.
 *
 * A denial with no reason cannot be defended, and an override with no reason is
 * indistinguishable from a mistake.
 */
const REASON_REQUIRED: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'deny',
  'resolve',
  'auto_resolve',
]);

export function requiresReason(action: AuditAction): boolean {
  return REASON_REQUIRED.has(action);
}

export interface RecordAuditStrictOptions {
  /**
   * Force the reason check regardless of `requiresReason(action)`. Exists for actions like
   * `'approve'` that only need a reason sometimes — an exchange approval that overrides a
   * warning, but not a plain approval — so the blanket `REASON_REQUIRED` set (which would
   * demand a reason on every approval everywhere) stays untouched.
   */
  requireReason?: boolean;
}

/** Record a change, refusing to proceed if this action demands a reason and none was given. */
export function recordAuditStrict(
  db: DbLike,
  input: AuditInput,
  opts?: RecordAuditStrictOptions,
): Id {
  const required = opts?.requireReason ?? requiresReason(input.action);
  if (required && !input.reason?.trim()) {
    throw new Error(
      `Audit action "${input.action}" on ${input.entityType} ${input.entityId} requires a reason. ` +
        'This text is what gets quoted if the decision is challenged.',
    );
  }
  return recordAudit(db, input);
}

/** Full history for one entity, newest first. Powers the "why is this like this?" view. */
export function auditHistoryFor(db: DbLike, entityType: string, entityId: Id): AuditLogEntry[] {
  const rows = db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)))
    // Newest first. Entries written in the same millisecond tie on `at`; rowid — insertion
    // order — breaks the tie. This table exists to answer "what happened, in what order?",
    // so an undefined order between a decision and its reversal is not acceptable.
    .orderBy(desc(auditLog.at), desc(sql`rowid`))
    .all();
  return rows.map(toAuditEntry);
}

/** The most recent entries across everything, for the activity feed. */
export function recentAudit(db: DbLike, limit = 50): AuditLogEntry[] {
  return db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.at), desc(sql`rowid`))
    .limit(limit)
    .all()
    .map(toAuditEntry);
}

function toAuditEntry(row: typeof auditLog.$inferSelect): AuditLogEntry {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    actor: row.actor,
    at: row.at,
    before: row.before ?? undefined,
    after: row.after ?? undefined,
    reason: row.reason ?? undefined,
  };
}
