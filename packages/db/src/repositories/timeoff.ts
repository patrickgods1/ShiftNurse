/**
 * Time-off requests.
 *
 * This table backs two things that will disagree with each other unless they read the exact
 * same rows: the solver's hard availability constraint (approved requests only) and the
 * manager's overlapping-requests heatmap (every request, so a cluster of *pending* asks is
 * visible before it becomes a staffing surprise). Both are served by one range query here.
 */

import type { Assignment, Id, IsoDate, TimeOffRequest, TimeOffStatus } from '@shiftnurse/core';
import { and, eq, gte, lte } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toTimeOffRequest } from '../mappers.js';
import { nurse, timeOffRequest } from '../schema.js';
import { deleteAssignment, getPeriod, listAssignmentsForNurseInRange } from './schedule.js';

/**
 * The table has no unit column — a request belongs to a nurse, who belongs to a unit — so
 * every unit-scoped query here joins through `nurse` rather than duplicating the unit id
 * onto every request row.
 */
export function listTimeOffForUnit(
  db: DbLike,
  unitId: Id,
  status?: TimeOffStatus,
): TimeOffRequest[] {
  const conditions = status
    ? and(eq(nurse.unitId, unitId), eq(timeOffRequest.status, status))
    : eq(nurse.unitId, unitId);
  return db
    .select({ req: timeOffRequest })
    .from(timeOffRequest)
    .innerJoin(nurse, eq(timeOffRequest.nurseId, nurse.id))
    .where(conditions)
    .all()
    .map((r) => toTimeOffRequest(r.req));
}

export function listTimeOffForNurse(db: DbLike, nurseId: Id): TimeOffRequest[] {
  return db
    .select()
    .from(timeOffRequest)
    .where(eq(timeOffRequest.nurseId, nurseId))
    .all()
    .map(toTimeOffRequest);
}

export function getTimeOffRequest(db: DbLike, id: Id): TimeOffRequest | undefined {
  const row = db.select().from(timeOffRequest).where(eq(timeOffRequest.id, id)).get();
  return row ? toTimeOffRequest(row) : undefined;
}

/**
 * Requests overlapping `[start, end]`, inclusive on both ends. One indexed query
 * (`time_off_range_idx`) serves both the solver's availability matrix, which needs every
 * approved request touching a period, and the overlapping-requests heatmap, which needs
 * every request regardless of status.
 */
export function listTimeOffOverlapping(db: DbLike, start: IsoDate, end: IsoDate): TimeOffRequest[] {
  return db
    .select()
    .from(timeOffRequest)
    .where(and(lte(timeOffRequest.startDate, end), gte(timeOffRequest.endDate, start)))
    .all()
    .map(toTimeOffRequest);
}

/**
 * Every request for a unit touching `[start, end]` (inclusive), whatever its status. The
 * heatmap and the competing-PTO detector both need the pending ones — a cluster of asks on one
 * weekend is a staffing problem before any of them is approved.
 */
export function listTimeOffOverlappingForUnit(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): TimeOffRequest[] {
  return db
    .select({ req: timeOffRequest })
    .from(timeOffRequest)
    .innerJoin(nurse, eq(timeOffRequest.nurseId, nurse.id))
    .where(
      and(
        eq(nurse.unitId, unitId),
        lte(timeOffRequest.startDate, end),
        gte(timeOffRequest.endDate, start),
      ),
    )
    .all()
    .map((r) => toTimeOffRequest(r.req));
}

/**
 * The hard availability constraint: approved time off for a unit, overlapping a range.
 * Denied and pending requests must never reach the solver as unavailability — only a
 * decision the manager has actually made removes a nurse from the pool.
 */
export function approvedTimeOffInRange(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): TimeOffRequest[] {
  return db
    .select({ req: timeOffRequest })
    .from(timeOffRequest)
    .innerJoin(nurse, eq(timeOffRequest.nurseId, nurse.id))
    .where(
      and(
        eq(nurse.unitId, unitId),
        eq(timeOffRequest.status, 'approved'),
        lte(timeOffRequest.startDate, end),
        gte(timeOffRequest.endDate, start),
      ),
    )
    .all()
    .map((r) => toTimeOffRequest(r.req));
}

export interface CreateTimeOffInput {
  nurseId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  type: TimeOffRequest['type'];
  reason?: string;
}

/**
 * `enteredBy` defaults to `'manager'` — v1 has no nurse-facing app, so every request is the
 * manager transcribing something asked verbally, on paper or by email. It is a parameter
 * rather than a hardcoded literal so nurse self-service can call this same function later
 * with `'nurse'` and reuse the identical table and approval workflow unchanged.
 */
export function createTimeOffRequest(
  db: DbLike,
  input: CreateTimeOffInput,
  actor: string,
  enteredBy: TimeOffRequest['enteredBy'] = 'manager',
): TimeOffRequest {
  const id = ids.timeOff();
  const row = {
    id,
    nurseId: input.nurseId,
    startDate: input.startDate,
    endDate: input.endDate,
    type: input.type,
    status: 'pending' as TimeOffStatus,
    enteredBy,
    submittedAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
    reason: input.reason ?? null,
    decisionReason: null,
  };
  db.insert(timeOffRequest).values(row).run();
  const created = toTimeOffRequest(row);
  recordAudit(db, {
    entityType: 'time_off_request',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

export function approveTimeOff(db: DbLike, id: Id, actor: string, reason?: string): TimeOffRequest {
  const before = getTimeOffRequest(db, id);
  if (!before) throw new Error(`Time-off request ${id} not found`);
  const decidedAt = Date.now();
  db.update(timeOffRequest)
    .set({ status: 'approved', decidedAt, decidedBy: actor, decisionReason: reason ?? null })
    .where(eq(timeOffRequest.id, id))
    .run();
  const after = getTimeOffRequest(db, id);
  if (!after) throw new Error(`Time-off request ${id} vanished during approval`);
  recordAudit(db, {
    entityType: 'time_off_request',
    entityId: id,
    action: 'approve',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

export interface ApprovalResult {
  request: TimeOffRequest;
  /** Draft assignments inside the range, removed as part of the approval. */
  lifted: Assignment[];
  /** Assignments inside the range on a published period, left in place and now a conflict. */
  stillRostered: Assignment[];
}

/**
 * Approval and the grid must agree in the same transaction. The decide dialog previews
 * approval as "these shifts are displaced"; if approval only flipped the status the nurse would
 * stay rostered through their own vacation and the hard `works_during_approved_time_off` rule
 * would fire on the grid days later — the one outcome that makes a nurse stop trusting the
 * schedule. So approval lifts the nurse's assignments inside the range from every *draft*
 * period, locked ones included (approved leave outranks a manager's pin). Published periods
 * are never edited silently: those shifts are reported back and surface as a
 * `scheduled_on_leave` conflict for the manager to resolve deliberately.
 */
export function approveTimeOffAndLiftAssignments(
  db: DbLike,
  id: Id,
  actor: string,
  reason?: string,
): ApprovalResult {
  const request = approveTimeOff(db, id, actor, reason);
  const lifted: Assignment[] = [];
  const stillRostered: Assignment[] = [];
  const periodStatus = new Map<Id, string | undefined>();
  for (const a of listAssignmentsForNurseInRange(
    db,
    request.nurseId,
    request.startDate,
    request.endDate,
  )) {
    if (!periodStatus.has(a.periodId))
      periodStatus.set(a.periodId, getPeriod(db, a.periodId)?.status);
    if (periodStatus.get(a.periodId) === 'draft') {
      deleteAssignment(db, a.id, actor, `Lifted for approved time off ${request.id}`);
      lifted.push(a);
    } else {
      stillRostered.push(a);
    }
  }
  return { request, lifted, stillRostered };
}

/**
 * Denial requires a non-empty reason: `recordAuditStrict` throws before the row is touched if
 * none is given. This text is what gets quoted, verbatim, if the denial is ever grieved — so
 * it cannot be an afterthought or a blank field slipped past validation.
 */
export function denyTimeOff(
  db: DbLike,
  id: Id,
  actor: string,
  decisionReason: string,
): TimeOffRequest {
  const before = getTimeOffRequest(db, id);
  if (!before) throw new Error(`Time-off request ${id} not found`);
  // Audited before the write: a denial that fails the reason check must not touch the row.
  recordAuditStrict(db, {
    entityType: 'time_off_request',
    entityId: id,
    action: 'deny',
    actor,
    before,
    reason: decisionReason,
  });
  const decidedAt = Date.now();
  db.update(timeOffRequest)
    .set({ status: 'denied', decidedAt, decidedBy: actor, decisionReason })
    .where(eq(timeOffRequest.id, id))
    .run();
  const after = getTimeOffRequest(db, id);
  if (!after) throw new Error(`Time-off request ${id} vanished during denial`);
  return after;
}

/** The nurse (or the manager on their behalf) withdraws a request that was never decided. */
export function cancelTimeOff(db: DbLike, id: Id, actor: string, reason?: string): TimeOffRequest {
  const before = getTimeOffRequest(db, id);
  if (!before) throw new Error(`Time-off request ${id} not found`);
  db.update(timeOffRequest).set({ status: 'cancelled' }).where(eq(timeOffRequest.id, id)).run();
  const after = getTimeOffRequest(db, id);
  if (!after) throw new Error(`Time-off request ${id} vanished during cancellation`);
  recordAudit(db, {
    entityType: 'time_off_request',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

/**
 * Un-approve a request that was already granted. This is a distinct action from `deny`
 * because the nurse may have already made plans around the approval — cancelling a vacation
 * someone booked flights for is a serious act, so it always carries a reason and is recorded
 * as an `'update'` rather than silently reverting to `'pending'` unremarked.
 */
export function withdrawApproval(
  db: DbLike,
  id: Id,
  actor: string,
  reason: string,
): TimeOffRequest {
  const before = getTimeOffRequest(db, id);
  if (!before) throw new Error(`Time-off request ${id} not found`);
  if (before.status !== 'approved') {
    throw new Error(
      `Time-off request ${id} is ${before.status}, not approved; nothing to withdraw`,
    );
  }
  db.update(timeOffRequest)
    .set({ status: 'pending', decidedAt: null, decidedBy: null, decisionReason: null })
    .where(eq(timeOffRequest.id, id))
    .run();
  const after = getTimeOffRequest(db, id);
  if (!after) throw new Error(`Time-off request ${id} vanished during withdrawal`);
  recordAudit(db, {
    entityType: 'time_off_request',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

export interface DecisionTally {
  approved: number;
  denied: number;
}

/**
 * Approved/denied tallies per nurse since a date. Feeds time-off approval equity in fairness
 * scoring — a nurse whose requests are disproportionately denied is being treated unfairly
 * even if every other schedule metric looks balanced.
 */
export function countDecisionsByNurse(
  db: DbLike,
  unitId: Id,
  sinceDate: IsoDate,
): Map<Id, DecisionTally> {
  const rows = db
    .select({ req: timeOffRequest })
    .from(timeOffRequest)
    .innerJoin(nurse, eq(timeOffRequest.nurseId, nurse.id))
    .where(and(eq(nurse.unitId, unitId), gte(timeOffRequest.startDate, sinceDate)))
    .all();
  const tallies = new Map<Id, DecisionTally>();
  for (const { req } of rows) {
    if (req.status !== 'approved' && req.status !== 'denied') continue;
    const tally = tallies.get(req.nurseId) ?? { approved: 0, denied: 0 };
    if (req.status === 'approved') tally.approved += 1;
    else tally.denied += 1;
    tallies.set(req.nurseId, tally);
  }
  return tallies;
}
