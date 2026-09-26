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
import { dayNumber, MS_PER_DAY, resolvePayRate } from '@shiftnurse/core';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
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
  schedulePeriod,
} from '../schema.js';
import { insertRows } from './bulk.js';
import { type PatchKeys, patchOf } from './patch.js';
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

// ---------------------------------------------------------------------------
// Cost configuration
// ---------------------------------------------------------------------------

/**
 * Every rate relevant to a unit: this unit's per-nurse overrides, plus every role-default row.
 * `pay_rate` has no unit column of its own — a per-nurse rate is scoped by joining through
 * `nurse`, and a role default has no owning unit at all (it is `nurseId: null`, the role's
 * base rate wherever it applies), so it is always included.
 */
/** Role defaults (shared by every unit) plus this unit's per-nurse rates. In insertion order:
 * `resolvePayRate` keeps the first of two rates with the same effective date. */
export function listPayRatesForUnit(db: DbLike, unitId: Id): PayRate[] {
  const unitNurses = db.select({ id: nurse.id }).from(nurse).where(eq(nurse.unitId, unitId));
  return db
    .select()
    .from(payRate)
    .where(or(isNull(payRate.nurseId), inArray(payRate.nurseId, unitNurses)))
    .orderBy(sql`rowid`)
    .all()
    .map(toPayRate);
}

/**
 * The rate in effect for a nurse on a date. The resolution rule itself — per-nurse beats the
 * role default, latest `effectiveFrom` not after the date wins — lives in core's
 * `resolvePayRate`, so the costing engine and this lookup can never disagree about what a
 * nurse is paid.
 */
export function effectiveRateForNurse(
  db: DbLike,
  nurseId: Id,
  role: NurseRole,
  date: IsoDate,
): PayRate | undefined {
  const candidates = db
    .select()
    .from(payRate)
    .where(or(eq(payRate.nurseId, nurseId), and(isNull(payRate.nurseId), eq(payRate.role, role))))
    .all()
    .map(toPayRate);
  return resolvePayRate(candidates, { id: nurseId, role }, date)?.rate;
}

export type PayRateInput = Omit<PayRate, 'id'>;

/**
 * A rate is scoped to exactly one of a nurse or a role. Both set would make "which rate wins"
 * ambiguous; neither set would be a rate for nobody. Refusing here keeps the resolution rule
 * simple enough to be provably right.
 */
function assertPayRateScope(input: Pick<PayRate, 'nurseId' | 'role'>): void {
  if (input.nurseId === null && input.role === null) {
    throw new Error('A pay rate must be scoped to a nurse or a role');
  }
  if (input.nurseId !== null && input.role !== null) {
    throw new Error('A pay rate is scoped to a nurse or a role, not both');
  }
}

export function createPayRate(db: DbLike, input: PayRateInput, actor: string): PayRate {
  assertPayRateScope(input);
  const id = ids.payRate();
  const row = {
    id,
    nurseId: input.nurseId,
    role: input.role,
    hourlyRate: input.hourlyRate,
    effectiveFrom: input.effectiveFrom,
  };
  db.insert(payRate).values(row).run();
  const created = toPayRate(row);
  recordAudit(db, {
    entityType: 'pay_rate',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

export type PayRatePatch = Partial<Pick<PayRate, 'hourlyRate' | 'effectiveFrom'>>;

/** Correct a rate's amount or start date. Scope is fixed: re-scoping is a delete and a create. */
export function updatePayRate(db: DbLike, id: Id, patch: PayRatePatch, actor: string): PayRate {
  const row = db.select().from(payRate).where(eq(payRate.id, id)).get();
  if (!row) throw new Error(`Pay rate ${id} not found`);
  const before = toPayRate(row);
  const values = {
    ...(patch.hourlyRate !== undefined ? { hourlyRate: patch.hourlyRate } : {}),
    ...(patch.effectiveFrom !== undefined ? { effectiveFrom: patch.effectiveFrom } : {}),
  };
  db.update(payRate).set(values).where(eq(payRate.id, id)).run();
  const after: PayRate = { ...before, ...values };
  recordAudit(db, { entityType: 'pay_rate', entityId: id, action: 'update', actor, before, after });
  return after;
}

export function deletePayRate(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(payRate).where(eq(payRate.id, id)).get();
  if (!row) throw new Error(`Pay rate ${id} not found`);
  const before = toPayRate(row);
  db.delete(payRate).where(eq(payRate.id, id)).run();
  recordAudit(db, { entityType: 'pay_rate', entityId: id, action: 'delete', actor, before });
}

export function listDifferentialsForUnit(db: DbLike, unitId: Id): Differential[] {
  return db
    .select()
    .from(differential)
    .where(eq(differential.unitId, unitId))
    .orderBy(sql`rowid`)
    .all()
    .map(toDifferential);
}

export function listActiveDifferentials(db: DbLike, unitId: Id): Differential[] {
  return listDifferentialsForUnit(db, unitId).filter((d) => d.active);
}

export type DifferentialInput = Omit<Differential, 'id'>;
export type DifferentialPatch = Partial<Pick<Differential, 'kind' | 'mode' | 'amount' | 'active'>>;

const DIFFERENTIAL_PATCH_KEYS: PatchKeys<DifferentialPatch> = {
  kind: true,
  mode: true,
  amount: true,
  active: true,
};

export function createDifferential(
  db: DbLike,
  input: DifferentialInput,
  actor: string,
): Differential {
  const id = ids.differential();
  const row = { id, ...input };
  db.insert(differential).values(row).run();
  const created = toDifferential(row);
  recordAudit(db, {
    entityType: 'differential',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

export function updateDifferential(
  db: DbLike,
  id: Id,
  patch: DifferentialPatch,
  actor: string,
): Differential {
  const row = db.select().from(differential).where(eq(differential.id, id)).get();
  if (!row) throw new Error(`Differential ${id} not found`);
  const before = toDifferential(row);
  const merged = { ...row, ...patchOf(patch, DIFFERENTIAL_PATCH_KEYS, 'differential') };
  db.update(differential).set(merged).where(eq(differential.id, id)).run();
  const after = toDifferential(merged);
  recordAudit(db, {
    entityType: 'differential',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

export function deleteDifferential(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(differential).where(eq(differential.id, id)).get();
  if (!row) throw new Error(`Differential ${id} not found`);
  const before = toDifferential(row);
  db.delete(differential).where(eq(differential.id, id)).run();
  recordAudit(db, { entityType: 'differential', entityId: id, action: 'delete', actor, before });
}

export function listOvertimeRulesForUnit(db: DbLike, unitId: Id): OvertimeRule[] {
  return db
    .select()
    .from(overtimeRule)
    .where(eq(overtimeRule.unitId, unitId))
    .orderBy(sql`rowid`)
    .all()
    .map(toOvertimeRule);
}

export function listActiveOvertimeRules(db: DbLike, unitId: Id): OvertimeRule[] {
  return listOvertimeRulesForUnit(db, unitId).filter((r) => r.active);
}

export type OvertimeRuleInput = Omit<OvertimeRule, 'id'>;
export type OvertimeRulePatch = Partial<
  Pick<OvertimeRule, 'basis' | 'thresholdHours' | 'multiplier' | 'active'>
>;

const OVERTIME_RULE_PATCH_KEYS: PatchKeys<OvertimeRulePatch> = {
  basis: true,
  thresholdHours: true,
  multiplier: true,
  active: true,
};

export function createOvertimeRule(
  db: DbLike,
  input: OvertimeRuleInput,
  actor: string,
): OvertimeRule {
  const id = ids.overtimeRule();
  const row = { id, ...input };
  db.insert(overtimeRule).values(row).run();
  const created = toOvertimeRule(row);
  recordAudit(db, {
    entityType: 'overtime_rule',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

export function updateOvertimeRule(
  db: DbLike,
  id: Id,
  patch: OvertimeRulePatch,
  actor: string,
): OvertimeRule {
  const row = db.select().from(overtimeRule).where(eq(overtimeRule.id, id)).get();
  if (!row) throw new Error(`Overtime rule ${id} not found`);
  const before = toOvertimeRule(row);
  const merged = { ...row, ...patchOf(patch, OVERTIME_RULE_PATCH_KEYS, 'overtime rule') };
  db.update(overtimeRule).set(merged).where(eq(overtimeRule.id, id)).run();
  const after = toOvertimeRule(merged);
  recordAudit(db, {
    entityType: 'overtime_rule',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

export function deleteOvertimeRule(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(overtimeRule).where(eq(overtimeRule.id, id)).get();
  if (!row) throw new Error(`Overtime rule ${id} not found`);
  const before = toOvertimeRule(row);
  db.delete(overtimeRule).where(eq(overtimeRule.id, id)).run();
  recordAudit(db, { entityType: 'overtime_rule', entityId: id, action: 'delete', actor, before });
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

/** A ledger row's counters, with every omitted counter as 0 — the one place those defaults live. */
function ledgerValues(input: UpsertFairnessLedgerInput) {
  return {
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
}

function ledgerRow(input: UpsertFairnessLedgerInput) {
  return {
    id: ids.fairness(),
    nurseId: input.nurseId,
    periodId: input.periodId,
    ...ledgerValues(input),
  };
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

  const values = ledgerValues(input);

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
  const rows = entries.map((input) => ledgerRow(input));
  insertRows(db, fairnessLedger, rows);
  const created = rows.map(toFairnessLedgerEntry);
  recordAudit(db, {
    entityType: 'fairness_ledger',
    entityId: 'batch' as Id,
    action: 'import',
    actor,
    after: { count: created.length },
  });
  return created;
}

/**
 * Period ids (with their start dates) already in the ledger for this unit's nurses.
 *
 * The historical-import screen needs this to warn a manager before they re-import a file that
 * would replace periods already on record, rather than let `importHistoricalLedger` silently
 * do the replacing.
 */
export function ledgerPeriodsForUnit(
  db: DbLike,
  unitId: Id,
): { periodId: Id; periodStart: IsoDate }[] {
  return db
    .selectDistinct({
      periodId: fairnessLedger.periodId,
      periodStart: fairnessLedger.periodStart,
    })
    .from(fairnessLedger)
    .innerJoin(nurse, eq(fairnessLedger.nurseId, nurse.id))
    .where(eq(nurse.unitId, unitId))
    .orderBy(fairnessLedger.periodStart)
    .all()
    .map((r) => ({ periodId: r.periodId, periodStart: r.periodStart as IsoDate }));
}

export interface LedgerImportResult {
  written: number;
  replaced: number;
}

/**
 * Import a historical schedule's derived ledger rows, replacing rather than upserting.
 *
 * `importFairnessLedgerEntries` (above) inserts blindly and exists for a one-time initial
 * seed. A CSV import is different: the manager may re-run it after fixing a typo in the
 * spreadsheet, and re-running it must not pile up duplicate rows behind the
 * `(nurseId, periodId)` unique index, nor leave some nurses on the old numbers and others on
 * the new ones for what is supposed to be a single period's history. So every period id
 * present in `entries` is cleared for this unit first — and only for this unit, so importing
 * one unit's history can never erase another's — and the new rows are inserted in its place,
 * all inside the caller's transaction (partial replacement is worse than none).
 *
 * Throws before making any change if an entry names a nurse who isn't on this unit: a ledger
 * row for the wrong unit is a data-integrity bug, not a case to paper over.
 */
export function importHistoricalLedger(
  db: DbLike,
  unitId: Id,
  entries: readonly UpsertFairnessLedgerInput[],
  actor: string,
): LedgerImportResult {
  const unitNurseIds = new Set(
    db
      .select({ id: nurse.id })
      .from(nurse)
      .where(eq(nurse.unitId, unitId))
      .all()
      .map((r) => r.id),
  );
  for (const entry of entries) {
    if (!unitNurseIds.has(entry.nurseId)) {
      throw new Error(
        `Cannot import a fairness ledger entry for nurse ${entry.nurseId}: not a nurse on unit ${unitId}.`,
      );
    }
  }

  const periodIds = [...new Set(entries.map((e) => e.periodId))];
  const nurseIdList = [...unitNurseIds];
  let replaced = 0;
  for (const periodId of periodIds) {
    const existing = db
      .select({ id: fairnessLedger.id })
      .from(fairnessLedger)
      .where(
        and(eq(fairnessLedger.periodId, periodId), inArray(fairnessLedger.nurseId, nurseIdList)),
      )
      .all();
    if (existing.length > 0) {
      db.delete(fairnessLedger)
        .where(
          inArray(
            fairnessLedger.id,
            existing.map((r) => r.id),
          ),
        )
        .run();
      replaced += existing.length;
    }
  }

  insertRows(
    db,
    fairnessLedger,
    entries.map((input) => ledgerRow(input)),
  );
  const written = entries.length;

  recordAudit(db, {
    entityType: 'fairness_ledger',
    entityId: 'batch' as Id,
    action: 'import',
    actor,
    before: { replaced, periodIds },
    after: { written, periodIds },
  });

  return { written, replaced };
}
