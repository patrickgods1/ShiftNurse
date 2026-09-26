/**
 * Shift exchange: 1:1 trades and giveaways, proposed and decided the same way a time-off
 * request is — a submitter, a status, a decider — because v1 is manager-only and this is the
 * seam nurse self-service reuses later.
 *
 * The one wrinkle relative to time off is that *approving* an exchange edits the grid: an
 * approved swap deletes the assignment(s) that moved and creates their replacements, in the
 * same transaction as the status flip, so the swap record and the grid can never disagree
 * about whether the exchange happened. Core's `planExchange` decides *what* rows change;
 * this module is the only place that writes them.
 */

import type {
  Assignment,
  ExchangeApplication,
  ExchangeProposal,
  Id,
  ShiftSwap,
  ShiftSwapStatus,
} from '@shiftnurse/core';
import { and, eq } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toShiftSwap } from '../mappers.js';
import { schedulePeriod, shiftSwap } from '../schema.js';
import { recordScheduleChange, requireChangeReason } from './publish.js';
import { createAssignment, deleteAssignment, getAssignment, getPeriod } from './schedule.js';

export function listSwapsForPeriod(
  db: DbLike,
  periodId: Id,
  status?: ShiftSwapStatus,
): ShiftSwap[] {
  const conditions = status
    ? and(eq(shiftSwap.periodId, periodId), eq(shiftSwap.status, status))
    : eq(shiftSwap.periodId, periodId);
  return db.select().from(shiftSwap).where(conditions).all().map(toShiftSwap);
}

/** Joins through `schedule_period` — like `time_off_request`, the table has no unit column. */
export function listSwapsForUnit(db: DbLike, unitId: Id, status?: ShiftSwapStatus): ShiftSwap[] {
  const conditions = status
    ? and(eq(schedulePeriod.unitId, unitId), eq(shiftSwap.status, status))
    : eq(schedulePeriod.unitId, unitId);
  return db
    .select({ swap: shiftSwap })
    .from(shiftSwap)
    .innerJoin(schedulePeriod, eq(shiftSwap.periodId, schedulePeriod.id))
    .where(conditions)
    .all()
    .map((r) => toShiftSwap(r.swap));
}

export function getSwap(db: DbLike, id: Id): ShiftSwap | undefined {
  const row = db.select().from(shiftSwap).where(eq(shiftSwap.id, id)).get();
  return row ? toShiftSwap(row) : undefined;
}

export interface ProposeSwapInput extends ExchangeProposal {
  periodId: Id;
  reason?: string;
}

/**
 * `enteredBy` defaults to `'manager'` for the same reason `createTimeOffRequest` does: v1 has
 * no nurse-facing app, so this is always the manager transcribing a request made verbally, on
 * paper or by phone.
 */
export function proposeSwap(
  db: DbLike,
  input: ProposeSwapInput,
  actor: string,
  enteredBy: ShiftSwap['enteredBy'] = 'manager',
): ShiftSwap {
  const id = ids.shiftSwap();
  const row = {
    id,
    periodId: input.periodId,
    kind: input.kind,
    requestingNurseId: input.requestingNurseId,
    counterpartyNurseId: input.counterpartyNurseId,
    offeredAssignmentId: input.offeredAssignmentId,
    requestedAssignmentId: input.requestedAssignmentId ?? null,
    status: 'proposed' as ShiftSwapStatus,
    enteredBy,
    submittedAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
    reason: input.reason ?? null,
    decisionReason: null,
    overrode: false,
  };
  db.insert(shiftSwap).values(row).run();
  const created = toShiftSwap(row);
  recordAudit(db, {
    entityType: 'shift_swap',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

/**
 * A denial without a reason is refused before the row is touched — same contract as
 * `denyTimeOff`, and for the same reason: this text is what gets quoted if it is grieved.
 */
export function denySwap(db: DbLike, id: Id, actor: string, decisionReason: string): ShiftSwap {
  const before = getSwap(db, id);
  if (!before) throw new Error(`Shift swap ${id} not found`);
  if (before.status !== 'proposed') {
    throw new Error(`Shift swap ${id} is ${before.status}, not proposed; nothing to deny`);
  }
  recordAuditStrict(db, {
    entityType: 'shift_swap',
    entityId: id,
    action: 'deny',
    actor,
    before,
    reason: decisionReason,
  });
  const decidedAt = Date.now();
  db.update(shiftSwap)
    .set({ status: 'denied', decidedAt, decidedBy: actor, decisionReason })
    .where(eq(shiftSwap.id, id))
    .run();
  const after = getSwap(db, id);
  if (!after) throw new Error(`Shift swap ${id} vanished during denial`);
  return after;
}

/** The nurse (or the manager on their behalf) withdraws a request that was never decided. */
export function cancelSwap(db: DbLike, id: Id, actor: string, reason?: string): ShiftSwap {
  const before = getSwap(db, id);
  if (!before) throw new Error(`Shift swap ${id} not found`);
  if (before.status !== 'proposed') {
    throw new Error(`Shift swap ${id} is ${before.status}, not proposed; nothing to cancel`);
  }
  db.update(shiftSwap).set({ status: 'cancelled' }).where(eq(shiftSwap.id, id)).run();
  const after = getSwap(db, id);
  if (!after) throw new Error(`Shift swap ${id} vanished during cancellation`);
  recordAudit(db, {
    entityType: 'shift_swap',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

export interface ApproveSwapOptions {
  /** True when the manager is approving over a warning; then `reason` is required. */
  overrode: boolean;
  reason?: string;
}

/**
 * Approve a proposed swap and, in the same call, replay `application` onto the grid:
 * `application.remove` assignments are deleted and `application.create` rows are inserted with
 * `source: 'manual'` — a swap is exactly the kind of manual edit that source already means.
 * Callers wrap this in `transact` alongside everything else that touches the grid, so a stale
 * id or a non-draft period leaves both the swap and the assignments untouched.
 *
 * Refuses:
 * - a swap that is not `proposed` (already decided, or withdrawn),
 * - a published period without a reason: staff hold that schedule, so the exchange is a
 *   post-publish edit and every shift it moves is written to the change log as `exchange`,
 * - an archived period,
 * - any `application.remove` id that no longer exists — the evaluation that produced
 *   `application` is stale and the caller must re-evaluate,
 * - an override with no reason.
 *
 * The audit entry is written *before* any row changes, exactly like `applyResolution`: a
 * refused approval — for a missing reason or a stale id — must not have partially applied.
 */
export function approveSwap(
  // A transaction, not any handle: these writes are only correct all-or-nothing.
  db: ShiftNurseTx,
  id: Id,
  application: ExchangeApplication,
  actor: string,
  opts: ApproveSwapOptions,
): ShiftSwap {
  const before = getSwap(db, id);
  if (!before) throw new Error(`Shift swap ${id} not found`);
  if (before.status !== 'proposed') {
    throw new Error(`Shift swap ${id} is ${before.status}, not proposed; nothing to approve`);
  }
  const period = getPeriod(db, before.periodId);
  if (!period) throw new Error(`Unknown period ${before.periodId}`);
  const changeReason = requireChangeReason(period, opts.reason);
  const removing: Assignment[] = [];
  for (const assignmentId of application.remove) {
    const existing = getAssignment(db, assignmentId);
    if (!existing) {
      throw new Error(
        `Assignment ${assignmentId} no longer exists; the exchange is stale — re-evaluate it`,
      );
    }
    removing.push(existing);
  }
  const reason = opts.reason?.trim();
  if (opts.overrode && !reason) {
    throw new Error(
      'Approving an exchange that overrides a warning requires a reason. ' +
        'This text is what gets quoted if the decision is challenged.',
    );
  }
  // Audited before the writes: a refused approval must not touch a row.
  recordAuditStrict(
    db,
    {
      entityType: 'shift_swap',
      entityId: id,
      action: 'approve',
      actor,
      before,
      reason,
      after: { application },
    },
    { requireReason: opts.overrode },
  );

  for (const removed of removing) {
    deleteAssignment(db, removed.id, actor, reason ?? `Shift exchange ${id}`);
    if (changeReason !== undefined) {
      recordScheduleChange(
        db,
        {
          periodId: removed.periodId,
          kind: 'removed',
          source: 'exchange',
          assignmentId: removed.id,
          nurseId: removed.nurseId,
          date: removed.date,
          shiftTypeId: removed.shiftTypeId,
          before: removed,
          reason: changeReason,
        },
        actor,
      );
    }
  }
  for (const created of application.create) {
    const row = createAssignment(
      db,
      {
        periodId: created.periodId,
        nurseId: created.nurseId,
        shiftTypeId: created.shiftTypeId,
        date: created.date,
        source: 'manual',
        isCharge: created.isCharge,
        isOvertime: created.isOvertime,
        notes: created.notes,
      },
      actor,
    );
    if (changeReason !== undefined) {
      recordScheduleChange(
        db,
        {
          periodId: row.periodId,
          kind: 'added',
          source: 'exchange',
          assignmentId: row.id,
          nurseId: row.nurseId,
          date: row.date,
          shiftTypeId: row.shiftTypeId,
          after: row,
          reason: changeReason,
        },
        actor,
      );
    }
  }

  const decidedAt = Date.now();
  db.update(shiftSwap)
    .set({
      status: 'approved',
      decidedAt,
      decidedBy: actor,
      decisionReason: reason ?? null,
      overrode: opts.overrode,
    })
    .where(eq(shiftSwap.id, id))
    .run();
  const after = getSwap(db, id);
  if (!after) throw new Error(`Shift swap ${id} vanished during approval`);
  return after;
}
