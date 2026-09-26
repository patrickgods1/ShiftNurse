/**
 * Day-of call-offs: reporting one, the call log of who was phoned and what they said, and the
 * outcome (covered, uncovered, cancelled). The replacement search itself is core's
 * `findReplacements`; this module only records what happened.
 */

import type {
  CallAttempt,
  CallOff,
  CallOffStatus,
  CallOutcome,
  Id,
  IsoDate,
} from '@shiftnurse/core';
import { dayNumber, MS_PER_DAY } from '@shiftnurse/core';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toCallAttempt, toCallOff } from '../mappers.js';
import { callAttempt, callOff, nurse, schedulePeriod } from '../schema.js';
import { getAssignment } from './schedule.js';

// ---------------------------------------------------------------------------
// Call-offs
// ---------------------------------------------------------------------------

export function getCallOff(db: DbLike, id: Id): CallOff | undefined {
  const row = db.select().from(callOff).where(eq(callOff.id, id)).get();
  return row ? toCallOff(row) : undefined;
}

/**
 * A unit's call-offs, filterable by status and an inclusive date range, for the Today
 * screen's history view. `call_off` has no unit column of its own, so it is scoped by joining
 * through `schedule_period`, the same pattern `lastCalledAt` uses through `nurse`.
 */
export function listCallOffsForUnit(
  db: DbLike,
  unitId: Id,
  opts: { status?: CallOffStatus; start?: IsoDate; end?: IsoDate } = {},
): CallOff[] {
  const conditions = [eq(schedulePeriod.unitId, unitId)];
  if (opts.status !== undefined) conditions.push(eq(callOff.status, opts.status));
  // IsoDate sorts lexically (see the schema header), so a plain text comparison is a valid
  // date range — no date parsing needed.
  if (opts.start !== undefined) conditions.push(gte(callOff.date, opts.start));
  if (opts.end !== undefined) conditions.push(lte(callOff.date, opts.end));
  return db
    .select({ callOff })
    .from(callOff)
    .innerJoin(schedulePeriod, eq(callOff.periodId, schedulePeriod.id))
    .where(and(...conditions))
    .orderBy(callOff.date, callOff.reportedAt, sql`call_off.rowid`)
    .all()
    .map((r) => toCallOff(r.callOff));
}

/** The open call-off against an assignment, if one is currently in progress. */
export function openCallOffForAssignment(db: DbLike, assignmentId: Id): CallOff | undefined {
  const row = db
    .select()
    .from(callOff)
    .where(and(eq(callOff.assignmentId, assignmentId), eq(callOff.status, 'open')))
    .get();
  return row ? toCallOff(row) : undefined;
}

/**
 * Report a call-off against an existing assignment. The assignment itself is untouched here —
 * it leaves the grid only when a backfill replaces it — but its shift is copied onto the
 * call-off so the record outlives the row.
 */
export function reportCallOff(
  db: DbLike,
  assignmentId: Id,
  actor: string,
  reason?: string,
): CallOff {
  const absent = getAssignment(db, assignmentId);
  if (!absent) throw new Error(`Assignment ${assignmentId} not found`);
  const id = ids.callOff();
  const row = {
    id,
    assignmentId,
    periodId: absent.periodId,
    nurseId: absent.nurseId,
    shiftTypeId: absent.shiftTypeId,
    date: absent.date,
    reportedAt: Date.now(),
    reason: reason ?? null,
    status: 'open' as CallOffStatus,
    replacementAssignmentId: null,
  };
  db.insert(callOff).values(row).run();
  const created = toCallOff(row);
  recordAudit(db, {
    entityType: 'call_off',
    entityId: id,
    action: 'call_off',
    actor,
    after: created,
    reason,
  });
  return created;
}

/** A replacement nurse was found: the call-off is covered by `replacementAssignmentId`. */
export function markCallOffCovered(
  db: DbLike,
  id: Id,
  replacementAssignmentId: Id,
  actor: string,
): CallOff {
  const before = getCallOff(db, id);
  if (!before) throw new Error(`Call-off ${id} not found`);
  if (before.status !== 'open') throw new Error(`Call-off ${id} is ${before.status}, not open`);
  db.update(callOff)
    .set({ status: 'covered', replacementAssignmentId })
    .where(eq(callOff.id, id))
    .run();
  const after = getCallOff(db, id);
  if (!after) throw new Error(`Call-off ${id} vanished during backfill`);
  recordAudit(db, {
    entityType: 'call_off',
    entityId: id,
    action: 'backfill',
    actor,
    before,
    after,
  });
  return after;
}

/**
 * No replacement was found before the shift started. The shift ran short-staffed.
 *
 * A reason is required — same as `deny`/`resolve` elsewhere — because "we gave up looking"
 * is exactly the fact a union representative will ask about later.
 */
export function markCallOffUncovered(db: DbLike, id: Id, actor: string, reason: string): CallOff {
  const before = getCallOff(db, id);
  if (!before) throw new Error(`Call-off ${id} not found`);
  if (before.status !== 'open') throw new Error(`Call-off ${id} is ${before.status}, not open`);
  const after: CallOff = { ...before, status: 'uncovered' };
  // Audited before the write: a blank reason must not flip the status and leave no record —
  // a retry with a real reason would then find the call-off already uncovered.
  recordAuditStrict(
    db,
    { entityType: 'call_off', entityId: id, action: 'update', actor, before, after, reason },
    { requireReason: true },
  );
  db.update(callOff).set({ status: 'uncovered' }).where(eq(callOff.id, id)).run();
  return after;
}

/** The nurse turned up after all, or the call-off was logged in error. Reason required. */
export function cancelCallOff(db: DbLike, id: Id, actor: string, reason: string): CallOff {
  const before = getCallOff(db, id);
  if (!before) throw new Error(`Call-off ${id} not found`);
  if (before.status !== 'open') throw new Error(`Call-off ${id} is ${before.status}, not open`);
  const after: CallOff = { ...before, status: 'cancelled' };
  // Audited before the write, same reasoning as `markCallOffUncovered` above.
  recordAuditStrict(
    db,
    { entityType: 'call_off', entityId: id, action: 'update', actor, before, after, reason },
    { requireReason: true },
  );
  db.update(callOff).set({ status: 'cancelled' }).where(eq(callOff.id, id)).run();
  return after;
}

// ---------------------------------------------------------------------------
// Call attempts
// ---------------------------------------------------------------------------

export function logCallAttempt(
  db: DbLike,
  callOffId: Id,
  nurseId: Id,
  outcome: CallOutcome,
  actor: string,
  notes?: string,
): CallAttempt {
  const against = getCallOff(db, callOffId);
  if (!against) throw new Error(`Call-off ${callOffId} not found`);
  if (against.status !== 'open') {
    throw new Error(`Call-off ${callOffId} is ${against.status}, not open`);
  }
  const id = ids.callAttempt();
  const row = {
    id,
    callOffId,
    nurseId,
    attemptedAt: Date.now(),
    outcome,
    notes: notes ?? null,
  };
  db.insert(callAttempt).values(row).run();
  const created = toCallAttempt(row);
  recordAudit(db, {
    entityType: 'call_attempt',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

export function listCallAttempts(db: DbLike, callOffId: Id): CallAttempt[] {
  return (
    db
      .select()
      .from(callAttempt)
      .where(eq(callAttempt.callOffId, callOffId))
      // Newest first. Attempts logged in the same millisecond tie on `attemptedAt`, so rowid
      // (insertion order) breaks the tie — otherwise the call log's order is undefined.
      .orderBy(desc(callAttempt.attemptedAt), desc(sql`rowid`))
      .all()
      .map(toCallAttempt)
  );
}

/**
 * Most recent attempt timestamp per nurse, unit-wide, since a date. This is what lets the
 * replacement finder spread call-outs across the whole eligible pool instead of exhausting
 * the same three people who always pick up the phone.
 *
 * Scoped by `unitId` via a join through `nurse`, the same pattern `timeoff.ts` uses, since
 * `call_attempt` — like `time_off_request` — has no unit column of its own.
 */
export function lastCalledAt(db: DbLike, unitId: Id, sinceDate: IsoDate): Map<Id, number> {
  const sinceMillis = dayNumber(sinceDate) * MS_PER_DAY;
  const rows = db
    .select({ nurseId: callAttempt.nurseId, attemptedAt: callAttempt.attemptedAt })
    .from(callAttempt)
    .innerJoin(nurse, eq(callAttempt.nurseId, nurse.id))
    .where(and(eq(nurse.unitId, unitId), gte(callAttempt.attemptedAt, sinceMillis)))
    .all();
  const result = new Map<Id, number>();
  for (const row of rows) {
    const current = result.get(row.nurseId);
    if (current === undefined || row.attemptedAt > current)
      result.set(row.nurseId, row.attemptedAt);
  }
  return result;
}
