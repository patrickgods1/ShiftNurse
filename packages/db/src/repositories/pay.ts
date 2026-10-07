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
import { isIsoDate, resolvePayRate } from '@shiftnurse/core';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toBudget, toDifferential, toOvertimeRule, toPayRate } from '../mappers.js';
import { budget, differential, nurse, overtimeRule, payRate, paySettings } from '../schema.js';
import { auditedUpdate, type PatchKeys } from './patch.js';

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

const PAY_RATE_PATCH_KEYS: PatchKeys<PayRatePatch> = { hourlyRate: true, effectiveFrom: true };

/** Correct a rate's amount or start date. Scope is fixed: re-scoping is a delete and a create. */
export function updatePayRate(db: DbLike, id: Id, patch: PayRatePatch, actor: string): PayRate {
  return auditedUpdate<PayRate, PayRatePatch>(db, {
    id,
    entityType: 'pay_rate',
    entityLabel: 'pay rate',
    allowed: PAY_RATE_PATCH_KEYS,
    patch,
    read: (rowId) => {
      const row = db.select().from(payRate).where(eq(payRate.id, rowId)).get();
      return row ? toPayRate(row) : undefined;
    },
    write: (rowId, values) => db.update(payRate).set(values).where(eq(payRate.id, rowId)).run(),
    notFound: `Pay rate ${id} not found`,
    validate: (values) => {
      // A NaN or negative rate would misprice every shift it covers without failing anywhere.
      if (
        values.hourlyRate !== undefined &&
        !(Number.isFinite(values.hourlyRate) && values.hourlyRate >= 0)
      ) {
        throw new Error('An hourly rate must be a number of dollars, zero or more.');
      }
      if (
        values.effectiveFrom !== undefined &&
        !(typeof values.effectiveFrom === 'string' && isIsoDate(values.effectiveFrom))
      ) {
        throw new Error('Effective from must be a date.');
      }
    },
    actor,
  });
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
/** `window: null` clears the clock window, going back to the shift type's flag. */
export type DifferentialPatch = Partial<
  Pick<Differential, 'kind' | 'mode' | 'amount' | 'active'>
> & {
  window?: Differential['window'] | null;
};

const DIFFERENTIAL_PATCH_KEYS: PatchKeys<DifferentialPatch> = {
  kind: true,
  mode: true,
  amount: true,
  active: true,
  window: true,
};

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Refuses a window that cannot be priced: an evening differential has no flag to fall back on,
 * so without a window it would silently pay nothing, and a window on any other kind would be
 * ignored by costing — both read as a configured premium that never appears on a payslip.
 */
function checkWindow(kind: Differential['kind'], window: Differential['window'] | undefined): void {
  if (window === undefined) {
    if (kind === 'evening') throw new Error('An evening differential needs a clock window');
    return;
  }
  if (kind !== 'night' && kind !== 'evening') {
    throw new Error(`A clock window applies only to night and evening differentials, not ${kind}`);
  }
  for (const time of [window.startTime, window.endTime]) {
    if (!CLOCK_TIME.test(time)) throw new Error(`Window time "${time}" must be HH:MM`);
  }
  const whole = window.wholeShiftAtHours;
  if (whole !== null && !(whole > 0)) {
    throw new Error('The whole-shift threshold must be more than 0 hours');
  }
}

function windowColumns(window: Differential['window'] | undefined) {
  return {
    windowStart: window?.startTime ?? null,
    windowEnd: window?.endTime ?? null,
    windowWholeShiftAtHours: window?.wholeShiftAtHours ?? null,
  };
}

export function createDifferential(
  db: DbLike,
  input: DifferentialInput,
  actor: string,
): Differential {
  checkWindow(input.kind, input.window);
  const id = ids.differential();
  const { window, ...rest } = input;
  const row = { id, ...rest, ...windowColumns(window) };
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
  return auditedUpdate<Differential, DifferentialPatch>(db, {
    id,
    entityType: 'differential',
    entityLabel: 'differential',
    allowed: DIFFERENTIAL_PATCH_KEYS,
    patch,
    read: (rowId) => {
      const row = db.select().from(differential).where(eq(differential.id, rowId)).get();
      return row ? toDifferential(row) : undefined;
    },
    validate: (values, before) => {
      const window = values.window === undefined ? before.window : (values.window ?? undefined);
      checkWindow(values.kind ?? before.kind, window);
    },
    // The id rides along so an empty patch still writes, as the full-row update always did.
    write: (rowId, values) => {
      const { window, ...columns } = values;
      db.update(differential)
        .set({
          ...columns,
          ...(window === undefined ? {} : windowColumns(window ?? undefined)),
          id: rowId,
        })
        .where(eq(differential.id, rowId))
        .run();
    },
    notFound: `Differential ${id} not found`,
    actor,
  });
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
  return auditedUpdate<OvertimeRule, OvertimeRulePatch>(db, {
    id,
    entityType: 'overtime_rule',
    entityLabel: 'overtime rule',
    allowed: OVERTIME_RULE_PATCH_KEYS,
    patch,
    read: (rowId) => {
      const row = db.select().from(overtimeRule).where(eq(overtimeRule.id, rowId)).get();
      return row ? toOvertimeRule(row) : undefined;
    },
    // The id rides along so an empty patch still writes, as the full-row update always did.
    write: (rowId, values) =>
      db
        .update(overtimeRule)
        .set({ ...values, id: rowId })
        .where(eq(overtimeRule.id, rowId))
        .run(),
    notFound: `Overtime rule ${id} not found`,
    actor,
  });
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
// Pay settings
// ---------------------------------------------------------------------------

/** Settings that are not rates, differentials or overtime rules. */
export interface PaySettings {
  /** The fewest hours a call-back pays, from the contract. 0 pays the hours worked. */
  callBackMinimumHours: number;
}

export const DEFAULT_PAY_SETTINGS: PaySettings = { callBackMinimumHours: 0 };

/** A unit that has saved nothing is paid by the defaults. */
export function getPaySettings(db: DbLike, unitId: Id): PaySettings {
  const row = db.select().from(paySettings).where(eq(paySettings.unitId, unitId)).get();
  return row ? { callBackMinimumHours: row.callBackMinimumHours } : { ...DEFAULT_PAY_SETTINGS };
}

export function savePaySettings(
  db: DbLike,
  unitId: Id,
  settings: PaySettings,
  actor: string,
): PaySettings {
  const hours = settings.callBackMinimumHours;
  // IPC input is typed, not checked: a negative or absurd minimum would price every call-back wrong.
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error('The call-back minimum must be between 0 and 24 hours');
  }
  const before = getPaySettings(db, unitId);
  const after: PaySettings = { callBackMinimumHours: hours };
  db.insert(paySettings)
    .values({ unitId, callBackMinimumHours: hours, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: paySettings.unitId,
      set: { callBackMinimumHours: hours, updatedAt: Date.now() },
    })
    .run();
  recordAudit(db, {
    entityType: 'pay_settings',
    entityId: unitId,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}
