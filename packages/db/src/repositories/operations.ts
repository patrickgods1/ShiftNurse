/**
 * Day-of operations: call-offs and the replacement search, cost configuration, and the
 * fairness ledger.
 *
 * `mappers.ts` does not yet have row→domain converters for these tables — the ones there
 * cover the entities `packages/core`'s rule engine reads today. Rather than reach into that
 * shared file (owned by a concurrent change) this module carries its own small `toX`
 * converters, in the exact same style: `null` becomes an absent optional property, and
 * nothing here does more than reshape a row.
 */

import type {
  Budget,
  CallAttempt,
  CallOff,
  CallOffStatus,
  CallOutcome,
  Differential,
  FairnessLedgerEntry,
  Id,
  IsoDate,
  NurseRole,
  OvertimeRule,
  PayRate,
} from '@shiftnurse/core';
import { compareDates, dayNumber, MS_PER_DAY } from '@shiftnurse/core';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import {
  toBudget,
  toCallAttempt,
  toCallOff,
  toDifferential,
  toFairnessLedgerEntry,
  toOvertimeRule,
  toPayRate,
} from '../mappers.js';
import {
  budget,
  callAttempt,
  callOff,
  differential,
  fairnessLedger,
  nurse,
  overtimeRule,
  payRate,
} from '../schema.js';

// ---------------------------------------------------------------------------
// Call-offs
// ---------------------------------------------------------------------------

export function listOpenCallOffs(db: DbLike): CallOff[] {
  return db.select().from(callOff).where(eq(callOff.status, 'open')).all().map(toCallOff);
}

export function getCallOff(db: DbLike, id: Id): CallOff | undefined {
  const row = db.select().from(callOff).where(eq(callOff.id, id)).get();
  return row ? toCallOff(row) : undefined;
}

/** Report a call-off against an existing assignment. The assignment itself is untouched. */
export function reportCallOff(
  db: DbLike,
  assignmentId: Id,
  actor: string,
  reason?: string,
): CallOff {
  const id = ids.callOff();
  const row = {
    id,
    assignmentId,
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

/** No replacement was found before the shift started. The shift ran short-staffed. */
export function markCallOffUncovered(db: DbLike, id: Id, actor: string, reason?: string): CallOff {
  const before = getCallOff(db, id);
  if (!before) throw new Error(`Call-off ${id} not found`);
  db.update(callOff).set({ status: 'uncovered' }).where(eq(callOff.id, id)).run();
  const after = getCallOff(db, id);
  if (!after) throw new Error(`Call-off ${id} vanished during update`);
  recordAudit(db, {
    entityType: 'call_off',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

export function cancelCallOff(db: DbLike, id: Id, actor: string, reason?: string): CallOff {
  const before = getCallOff(db, id);
  if (!before) throw new Error(`Call-off ${id} not found`);
  db.update(callOff).set({ status: 'cancelled' }).where(eq(callOff.id, id)).run();
  const after = getCallOff(db, id);
  if (!after) throw new Error(`Call-off ${id} vanished during cancellation`);
  recordAudit(db, {
    entityType: 'call_off',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
    reason,
  });
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

// ---------------------------------------------------------------------------
// Cost configuration
// ---------------------------------------------------------------------------

/**
 * Every rate relevant to a unit: this unit's per-nurse overrides, plus every role-default row.
 * `pay_rate` has no unit column of its own — a per-nurse rate is scoped by joining through
 * `nurse`, and a role default has no owning unit at all (it is `nurseId: null`, the role's
 * base rate wherever it applies), so it is always included.
 */
export function listPayRatesForUnit(db: DbLike, unitId: Id): PayRate[] {
  const nurseIdsInUnit = new Set(
    db
      .select({ id: nurse.id })
      .from(nurse)
      .where(eq(nurse.unitId, unitId))
      .all()
      .map((r) => r.id),
  );
  return db
    .select()
    .from(payRate)
    .all()
    .filter((r) => r.nurseId === null || nurseIdsInUnit.has(r.nurseId))
    .map(toPayRate);
}

/**
 * The rate in effect for a nurse on a date.
 *
 * A per-nurse rate always wins over the role default — someone's individually negotiated
 * rate is never overridden by a blanket role rate. Among several candidates, the one with
 * the latest `effectiveFrom` that is not after `date` wins: rates are declared as of a date
 * and stay in effect until superseded, so "latest not-after" is exactly "currently in force".
 */
export function effectiveRateForNurse(
  db: DbLike,
  nurseId: Id,
  role: NurseRole,
  date: IsoDate,
): PayRate | undefined {
  const nurseRates = db.select().from(payRate).where(eq(payRate.nurseId, nurseId)).all();
  const nurseRate = latestNotAfter(nurseRates, date);
  if (nurseRate) return toPayRate(nurseRate);

  const roleRates = db
    .select()
    .from(payRate)
    .where(and(eq(payRate.role, role)))
    .all();
  const roleRate = latestNotAfter(roleRates, date);
  return roleRate ? toPayRate(roleRate) : undefined;
}

function latestNotAfter(
  rows: readonly (typeof payRate.$inferSelect)[],
  date: IsoDate,
): typeof payRate.$inferSelect | undefined {
  let best: typeof payRate.$inferSelect | undefined;
  for (const row of rows) {
    const effectiveFrom = row.effectiveFrom as IsoDate;
    if (compareDates(effectiveFrom, date) > 0) continue;
    if (!best || compareDates(effectiveFrom, best.effectiveFrom as IsoDate) > 0) best = row;
  }
  return best;
}

export function listActiveDifferentials(db: DbLike, unitId: Id): Differential[] {
  return db
    .select()
    .from(differential)
    .where(and(eq(differential.unitId, unitId), eq(differential.active, true)))
    .all()
    .map(toDifferential);
}

export function listActiveOvertimeRules(db: DbLike, unitId: Id): OvertimeRule[] {
  return db
    .select()
    .from(overtimeRule)
    .where(and(eq(overtimeRule.unitId, unitId), eq(overtimeRule.active, true)))
    .all()
    .map(toOvertimeRule);
}

export function getBudget(db: DbLike, periodId: Id): Budget | undefined {
  const row = db.select().from(budget).where(eq(budget.periodId, periodId)).get();
  return row ? toBudget(row) : undefined;
}

export function setBudget(
  db: DbLike,
  unitId: Id,
  periodId: Id,
  targetDollars: number,
  actor: string,
): Budget {
  const existing = db.select().from(budget).where(eq(budget.periodId, periodId)).get();
  if (existing) {
    const before = toBudget(existing);
    db.update(budget).set({ targetDollars }).where(eq(budget.id, existing.id)).run();
    const after: Budget = { ...before, targetDollars };
    recordAudit(db, {
      entityType: 'budget',
      entityId: existing.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }
  const id = ids.budget();
  const row = { id, unitId, periodId, targetDollars };
  db.insert(budget).values(row).run();
  const created = toBudget(row);
  recordAudit(db, { entityType: 'budget', entityId: id, action: 'create', actor, after: created });
  return created;
}

// ---------------------------------------------------------------------------
// Fairness ledger
// ---------------------------------------------------------------------------

export function getFairnessLedgerEntry(
  db: DbLike,
  nurseId: Id,
  periodId: Id,
): FairnessLedgerEntry | undefined {
  const row = db
    .select()
    .from(fairnessLedger)
    .where(and(eq(fairnessLedger.nurseId, nurseId), eq(fairnessLedger.periodId, periodId)))
    .get();
  return row ? toFairnessLedgerEntry(row) : undefined;
}

/**
 * A rolling window of ledger entries for every nurse in a unit, ordered by period start.
 * Fairness scoring reads this to compare a nurse's recent burden against the team's.
 *
 * Scoped through `nurse`, same reasoning as `timeoff.ts` and `lastCalledAt`: the ledger
 * itself has no unit column.
 */
export function ledgerSince(db: DbLike, unitId: Id, sinceDate: IsoDate): FairnessLedgerEntry[] {
  const rows = db
    .select({ ledger: fairnessLedger })
    .from(fairnessLedger)
    .innerJoin(nurse, eq(fairnessLedger.nurseId, nurse.id))
    .where(and(eq(nurse.unitId, unitId), gte(fairnessLedger.periodStart, sinceDate)))
    .orderBy(fairnessLedger.periodStart)
    .all();
  return rows.map((r) => toFairnessLedgerEntry(r.ledger));
}

export interface UpsertFairnessLedgerInput {
  nurseId: Id;
  periodId: Id;
  periodStart: IsoDate;
  nightShifts?: number;
  weekendsWorked?: number;
  holidaysWorked?: number;
  onCallShifts?: number;
  undesirableShifts?: number;
  requestsApproved?: number;
  requestsDenied?: number;
  callOutsCovered?: number;
  totalHours?: number;
  overtimeHours?: number;
  preferenceHitRate?: number;
}

export function upsertFairnessLedgerEntry(
  db: DbLike,
  input: UpsertFairnessLedgerInput,
  actor: string,
): FairnessLedgerEntry {
  const existing = db
    .select()
    .from(fairnessLedger)
    .where(
      and(eq(fairnessLedger.nurseId, input.nurseId), eq(fairnessLedger.periodId, input.periodId)),
    )
    .get();

  const values = {
    periodStart: input.periodStart,
    nightShifts: input.nightShifts ?? 0,
    weekendsWorked: input.weekendsWorked ?? 0,
    holidaysWorked: input.holidaysWorked ?? 0,
    onCallShifts: input.onCallShifts ?? 0,
    undesirableShifts: input.undesirableShifts ?? 0,
    requestsApproved: input.requestsApproved ?? 0,
    requestsDenied: input.requestsDenied ?? 0,
    callOutsCovered: input.callOutsCovered ?? 0,
    totalHours: input.totalHours ?? 0,
    overtimeHours: input.overtimeHours ?? 0,
    preferenceHitRate: input.preferenceHitRate ?? 0,
  };

  if (existing) {
    const before = toFairnessLedgerEntry(existing);
    db.update(fairnessLedger).set(values).where(eq(fairnessLedger.id, existing.id)).run();
    const after: FairnessLedgerEntry = { ...before, ...values };
    recordAudit(db, {
      entityType: 'fairness_ledger',
      entityId: existing.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }

  const id = ids.fairness();
  const row = { id, nurseId: input.nurseId, periodId: input.periodId, ...values };
  db.insert(fairnessLedger).values(row).run();
  const created = toFairnessLedgerEntry(row);
  recordAudit(db, {
    entityType: 'fairness_ledger',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

/**
 * Bulk-insert historical ledger entries, e.g. when onboarding a unit mid-year from a paper
 * or spreadsheet system. One `'import'` audit entry covers the whole batch — recording each
 * row individually would bury the one fact that matters ("we imported N periods of history
 * on this date") under N indistinguishable `'create'` entries.
 */
export function importFairnessLedgerEntries(
  db: DbLike,
  entries: readonly UpsertFairnessLedgerInput[],
  actor: string,
): FairnessLedgerEntry[] {
  const created: FairnessLedgerEntry[] = [];
  for (const input of entries) {
    const id = ids.fairness();
    const row = {
      id,
      nurseId: input.nurseId,
      periodId: input.periodId,
      periodStart: input.periodStart,
      nightShifts: input.nightShifts ?? 0,
      weekendsWorked: input.weekendsWorked ?? 0,
      holidaysWorked: input.holidaysWorked ?? 0,
      onCallShifts: input.onCallShifts ?? 0,
      undesirableShifts: input.undesirableShifts ?? 0,
      requestsApproved: input.requestsApproved ?? 0,
      requestsDenied: input.requestsDenied ?? 0,
      callOutsCovered: input.callOutsCovered ?? 0,
      totalHours: input.totalHours ?? 0,
      overtimeHours: input.overtimeHours ?? 0,
      preferenceHitRate: input.preferenceHitRate ?? 0,
    };
    db.insert(fairnessLedger).values(row).run();
    created.push(toFairnessLedgerEntry(row));
  }
  recordAudit(db, {
    entityType: 'fairness_ledger',
    entityId: 'batch' as Id,
    action: 'import',
    actor,
    after: { count: created.length },
  });
  return created;
}
