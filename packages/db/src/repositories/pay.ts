/**
 * Cost configuration: pay rates (per nurse or per role), differentials, overtime rules and each
 * period's budget. Core's `resolvePayRate` is the one definition of "the rate in force"; nothing
 * here decides it a second way.
 */

import type {
  Budget,
  Differential,
  Id,
  IsoDate,
  NurseRole,
  OvertimeRule,
  PayRate,
} from '@shiftnurse/core';
import { resolvePayRate } from '@shiftnurse/core';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toBudget, toDifferential, toOvertimeRule, toPayRate } from '../mappers.js';
import { budget, differential, nurse, overtimeRule, payRate } from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

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
