/**
 * Time-off requests.
 *
 * This table backs two things that will disagree with each other unless they read the exact
 * same rows: the solver's hard availability constraint (approved requests only) and the
 * manager's overlapping-requests heatmap (every request, so a cluster of *pending* asks is
 * visible before it becomes a staffing surprise). Both are served by one range query here.
 */

import {
  type Assignment,
  addDays,
  compareDates,
  datesInRange,
  type Id,
  type IsoDate,
  isFloatedOff,
  isIsoDate,
  overlappingLeaveDate,
  type RuleSet,
  resolveConfigs,
  type ShiftType,
  type TimeOffParams,
  type TimeOffRequest,
  type TimeOffStatus,
  timeOffRule,
} from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit, recordAuditStrict, requireAuditReason } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toShiftType, toTimeOffRequest } from '../mappers.js';
import { nurse, shiftType, timeOffRequest } from '../schema.js';
import { getRuleSet } from './rulesets.js';
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
  return (
    db
      .select({ req: timeOffRequest })
      .from(timeOffRequest)
      .innerJoin(nurse, eq(timeOffRequest.nurseId, nurse.id))
      .where(conditions)
      // The solver reads this list in order and must give identical schedules for identical
      // inputs; with no ORDER BY SQLite returns rows in whatever order the query plan finds them.
      .orderBy(asc(timeOffRequest.startDate), asc(timeOffRequest.id))
      .all()
      .map((r) => toTimeOffRequest(r.req))
  );
}

export function listTimeOffForNurse(db: DbLike, nurseId: Id): TimeOffRequest[] {
  return (
    db
      .select()
      .from(timeOffRequest)
      .where(eq(timeOffRequest.nurseId, nurseId))
      // Feeds perNurseRecordsFor, which is solver input: identical inputs must give identical
      // schedules.
      .orderBy(asc(timeOffRequest.startDate), asc(timeOffRequest.id))
      .all()
      .map(toTimeOffRequest)
  );
}

export function getTimeOffRequest(db: DbLike, id: Id): TimeOffRequest | undefined {
  const row = db.select().from(timeOffRequest).where(eq(timeOffRequest.id, id)).get();
  return row ? toTimeOffRequest(row) : undefined;
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
  return (
    db
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
      // Same order as listTimeOffForUnit, so a bounded read is the unbounded one minus rows.
      .orderBy(asc(timeOffRequest.startDate), asc(timeOffRequest.id))
      .all()
      .map((r) => toTimeOffRequest(r.req))
  );
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
  return (
    db
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
      // Same order as listTimeOffForUnit: the solver reads this list in order.
      .orderBy(asc(timeOffRequest.startDate), asc(timeOffRequest.id))
      .all()
      .map((r) => toTimeOffRequest(r.req))
  );
}

export interface CreateTimeOffInput {
  nurseId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  type: TimeOffRequest['type'];
  reason?: string;
  /** Paid leave hours charged: the shifts the nurse would have worked. Absent for unpaid. */
  paidHours?: number;
}

/**
 * Paid hours must be a real amount the request could pay: not negative, not more than every
 * hour of every day it covers, and none at all for unpaid leave — a paid "unpaid leave" would
 * quietly count toward the nurse's contract.
 */
function checkPaidHours(input: CreateTimeOffInput): number | null {
  const hours = input.paidHours;
  if (hours === undefined || hours === 0) return null;
  if (!Number.isFinite(hours) || hours < 0) throw new Error('Paid hours cannot be negative');
  if (input.type === 'unpaid') throw new Error('Unpaid leave cannot carry paid hours');
  const days = datesInRange(input.startDate, input.endDate).length;
  if (hours > days * 24) {
    throw new Error(`${hours} paid hours is more than the ${days} day(s) the request covers`);
  }
  return hours;
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
  // A backwards or malformed request covers no dates, so the heatmap and solver would ignore it.
  if (!isIsoDate(input.startDate)) {
    throw new Error(`The leave's start date "${input.startDate}" is not a date.`);
  }
  if (!isIsoDate(input.endDate)) {
    throw new Error(`The leave's end date "${input.endDate}" is not a date.`);
  }
  if (compareDates(input.endDate, input.startDate) < 0) {
    throw new Error('The leave request ends before it starts.');
  }
  const paidHours = checkPaidHours(input);
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
    paidHours,
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

export type TimeOffDecision = 'approve' | 'deny' | 'cancel' | 'withdraw';

/**
 * The one lifecycle of a request: which statuses each decision may start from. Without a single
 * table an approved vacation could be "denied" or cancelled with no reason, the lifted shift
 * stayed lifted, and the equity tally counted a denial that never was one.
 */
export const TIME_OFF_TRANSITIONS: Readonly<Record<TimeOffDecision, readonly TimeOffStatus[]>> = {
  approve: ['pending', 'denied'], // a denial can be reconsidered; the denial stays on record
  deny: ['pending'],
  cancel: ['pending'],
  withdraw: ['approved'],
};

const WITHDRAW_INSTEAD = 'This request is approved. Withdraw the approval instead, with a reason.';

/** Words for each refused edge. No ids: the manager reads these verbatim. */
const TRANSITION_REFUSALS: Record<TimeOffDecision, Partial<Record<TimeOffStatus, string>>> = {
  approve: {
    approved: 'This request is already approved.',
    cancelled:
      'This request was cancelled. Enter a new request if the nurse still wants the time off.',
  },
  deny: {
    approved: WITHDRAW_INSTEAD,
    denied: 'This request is already denied.',
    cancelled: 'This request was cancelled; there is nothing to deny.',
  },
  cancel: {
    approved: WITHDRAW_INSTEAD,
    denied: 'This request was denied; there is nothing to cancel.',
    cancelled: 'This request is already cancelled.',
  },
  withdraw: {
    pending: 'This request is not approved yet; there is no approval to withdraw.',
    denied: 'This request was denied; there is no approval to withdraw.',
    cancelled: 'This request was cancelled; there is no approval to withdraw.',
  },
};

/** Throws, in words, unless the decision is a declared edge from the request's current status. */
export function requireTimeOffTransition(request: TimeOffRequest, decision: TimeOffDecision): void {
  if (TIME_OFF_TRANSITIONS[decision].includes(request.status)) return;
  throw new Error(
    TRANSITION_REFUSALS[decision][request.status] ??
      `This request is ${request.status}; it cannot be decided that way.`,
  );
}

export function approveTimeOff(db: DbLike, id: Id, actor: string, reason?: string): TimeOffRequest {
  const before = getTimeOffRequest(db, id);
  if (!before) throw new Error(`Time-off request ${id} not found`);
  requireTimeOffTransition(before, 'approve');
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

function nightBeforeCounts(ruleSet: RuleSet): TimeOffParams | undefined {
  const c = resolveConfigs(ruleSet).find((x) => x.ruleId === timeOffRule.id);
  return c?.enabled && c.params.nightShiftEndingOnLeaveCounts === true
    ? (c.params as unknown as TimeOffParams)
    : undefined;
}

/**
 * Approval and the grid must agree in the same transaction. The decide dialog previews
 * approval as "these shifts are displaced"; if approval only flipped the status the nurse would
 * stay rostered through their own vacation and the hard `works_during_approved_time_off` rule
 * would fire on the grid days later — the one outcome that makes a nurse stop trusting the
 * schedule. So approval lifts the nurse's assignments inside the range from every *draft*
 * period, locked ones included (approved leave outranks a manager's pin). Published periods
 * are never edited silently: those shifts are reported back and surface as a
 * `scheduled_on_leave` conflict for the manager to resolve deliberately. When the period's own
 * rule set counts a night ending on the first leave day (`nightShiftEndingOnLeaveCounts`), the
 * night dated the day before is handled the same way, so approval never leaves a violation (D31).
 * A shift she was floated off (D20) is neither lifted nor reported: it records hours she worked.
 */
export function approveTimeOffAndLiftAssignments(
  // A transaction, not any handle: these writes are only correct all-or-nothing.
  db: ShiftNurseTx,
  id: Id,
  actor: string,
  reason?: string,
): ApprovalResult {
  const request = approveTimeOff(db, id, actor, reason);
  const lifted: Assignment[] = [];
  const stillRostered: Assignment[] = [];
  const periodInfo = new Map<Id, { status?: string; nightBefore?: TimeOffParams }>();
  const shiftTypes = new Map<Id, ShiftType>();
  const infoFor = (periodId: Id) => {
    let info = periodInfo.get(periodId);
    if (!info) {
      const period = getPeriod(db, periodId);
      let nightBefore: TimeOffParams | undefined;
      if (period) {
        // The period's own snapshot, not the latest rules: the grid judges it by the same one.
        const ruleSet = getRuleSet(db, period.ruleSetId);
        if (!ruleSet)
          throw new Error(`Period ${periodId} cites unknown rule set ${period.ruleSetId}`);
        nightBefore = nightBeforeCounts(ruleSet);
      }
      info = { status: period?.status, nightBefore };
      periodInfo.set(periodId, info);
    }
    return info;
  };
  const shiftTypeFor = (shiftTypeId: Id): ShiftType => {
    let st = shiftTypes.get(shiftTypeId);
    if (!st) {
      const row = db.select().from(shiftType).where(eq(shiftType.id, shiftTypeId)).get();
      if (!row) throw new Error(`Shift type ${shiftTypeId} not found`);
      st = toShiftType(row);
      shiftTypes.set(shiftTypeId, st);
    }
    return st;
  };
  for (const a of listAssignmentsForNurseInRange(
    db,
    request.nurseId,
    addDays(request.startDate, -1),
    request.endDate,
  )) {
    // A shift she was floated off is a record of hours worked elsewhere, not one the leave frees.
    if (isFloatedOff(a)) continue;
    const info = infoFor(a.periodId);
    if (compareDates(a.date, request.startDate) < 0) {
      if (
        !info.nightBefore ||
        !overlappingLeaveDate(a.date, shiftTypeFor(a.shiftTypeId), request, info.nightBefore)
      )
        continue;
    }
    if (info.status === 'draft') {
      deleteAssignment(db, a.id, actor, `Lifted for approved time off ${request.id}`);
      lifted.push(a);
    } else {
      stillRostered.push(a);
    }
  }
  return { request, lifted, stillRostered };
}

/**
 * Denial requires a non-empty reason, checked before the row is touched; the row and its audit
 * entry (with both snapshots) then exist only together. This text is what gets quoted,
 * verbatim, if the denial is ever grieved — so it cannot be an afterthought or a blank field
 * slipped past validation.
 */
export function denyTimeOff(
  db: DbLike,
  id: Id,
  actor: string,
  decisionReason: string,
): TimeOffRequest {
  const before = getTimeOffRequest(db, id);
  if (!before) throw new Error(`Time-off request ${id} not found`);
  requireTimeOffTransition(before, 'deny');
  const reason = requireAuditReason({
    action: 'deny',
    entityType: 'time_off_request',
    entityId: id,
    reason: decisionReason,
  });
  const decidedAt = Date.now();
  db.update(timeOffRequest)
    .set({ status: 'denied', decidedAt, decidedBy: actor, decisionReason: reason })
    .where(eq(timeOffRequest.id, id))
    .run();
  const after = getTimeOffRequest(db, id);
  if (!after) throw new Error(`Time-off request ${id} vanished during denial`);
  recordAuditStrict(db, {
    entityType: 'time_off_request',
    entityId: id,
    action: 'deny',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

/**
 * The nurse (or the manager on their behalf) withdraws a request that was never decided. The
 * reason stays optional on purpose: only a pending request can be cancelled, so there is no
 * decision to quote. An approved one goes through `withdrawApproval`, which insists on one.
 */
export function cancelTimeOff(db: DbLike, id: Id, actor: string, reason?: string): TimeOffRequest {
  const before = getTimeOffRequest(db, id);
  if (!before) throw new Error(`Time-off request ${id} not found`);
  requireTimeOffTransition(before, 'cancel');
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
  requireTimeOffTransition(before, 'withdraw');
  const trimmed = requireAuditReason({
    action: 'update',
    entityType: 'time_off_request',
    entityId: id,
    reason,
  });
  db.update(timeOffRequest)
    .set({ status: 'pending', decidedAt: null, decidedBy: null, decisionReason: null })
    .where(eq(timeOffRequest.id, id))
    .run();
  const after = getTimeOffRequest(db, id);
  if (!after) throw new Error(`Time-off request ${id} vanished during withdrawal`);
  recordAuditStrict(
    db,
    {
      entityType: 'time_off_request',
      entityId: id,
      action: 'update',
      actor,
      before,
      after,
      reason: trimmed,
    },
    { requireReason: true },
  );
  return after;
}

export interface DecisionTally {
  approved: number;
  denied: number;
}

/**
 * Approved/denied tallies per nurse since a date. Windows on the leave's start date, not on when
 * it was decided: the equity question is whose leave in this stretch was refused.
 * Feeds time-off approval equity in fairness
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
