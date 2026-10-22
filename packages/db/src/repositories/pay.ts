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
  PaySettings,
  ScheduleKind,
} from '@shiftnurse/core';
import {
  COST_LINE_LABELS,
  DEFAULT_PAY_SETTINGS,
  DIFFERENTIAL_ORDER,
  describeDate,
  isIsoDate,
  resolvePayRate,
  SCHEDULE_KINDS,
} from '@shiftnurse/core';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toBudget, toDifferential, toOvertimeRule, toPayRate } from '../mappers.js';
import {
  budget,
  differential,
  nurse,
  overtimeRule,
  payRate,
  paySettings,
  schedulePeriod,
} from '../schema.js';
import { auditedUpdate, type PatchKeys } from './patch.js';

// ---------------------------------------------------------------------------
// Cost configuration
// ---------------------------------------------------------------------------

/**
 * Every rate relevant to a unit: this unit's per-nurse overrides, plus every role-default row.
 * `pay_rate` has no unit column of its own — a per-nurse rate is scoped by joining through
 * `nurse`, and a role default has no owning unit at all (it is `nurseId: null`, the role's
 * base rate wherever it applies), so it is always included. In insertion order, which no
 * longer matters to pricing: there is one rate per scope and start date (unique index).
 */
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

/** These nurses' own rates (no role defaults), for `perNurseRecordsFor`. */
export function listPayRatesForNurses(db: DbLike, nurseIds: readonly Id[]): PayRate[] {
  if (nurseIds.length === 0) return [];
  return db
    .select()
    .from(payRate)
    .where(inArray(payRate.nurseId, [...nurseIds]))
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

/**
 * A NaN or negative rate would misprice every shift it covers without failing anywhere. One
 * function so creating a rate refuses what changing one always did.
 */
function checkPayRate(values: { hourlyRate?: number; effectiveFrom?: unknown }): void {
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
}

/**
 * Refuses a second rate for the same person (or role default) from the same day. Core keeps the
 * first of two same-day rates, so a later "correction" would be stored and never applied.
 */
function checkRateDateFree(
  db: DbLike,
  scope: Pick<PayRate, 'nurseId' | 'role'>,
  effectiveFrom: IsoDate,
  exceptId?: Id,
): void {
  if (scope.nurseId !== null) {
    const person = db
      .select({ firstName: nurse.firstName, lastName: nurse.lastName })
      .from(nurse)
      .where(eq(nurse.id, scope.nurseId))
      .get();
    if (!person) throw new Error('That nurse was not found. Reload the page.');
    const clash = db
      .select({ id: payRate.id })
      .from(payRate)
      .where(and(eq(payRate.nurseId, scope.nurseId), eq(payRate.effectiveFrom, effectiveFrom)))
      .all()
      .some((r) => r.id !== exceptId);
    if (clash) {
      throw new Error(
        `${person.firstName} ${person.lastName} already has a pay rate from ${describeDate(effectiveFrom, { year: true })}; change that one instead.`,
      );
    }
    return;
  }
  const clash = db
    .select({ id: payRate.id })
    .from(payRate)
    .where(
      and(
        isNull(payRate.nurseId),
        eq(payRate.role, scope.role as NurseRole),
        eq(payRate.effectiveFrom, effectiveFrom),
      ),
    )
    .all()
    .some((r) => r.id !== exceptId);
  if (clash) {
    throw new Error(
      `There is already a default ${scope.role} rate from ${describeDate(effectiveFrom, { year: true })}; change that one instead.`,
    );
  }
}

export function createPayRate(db: DbLike, input: PayRateInput, actor: string): PayRate {
  assertPayRateScope(input);
  checkPayRate(input);
  checkRateDateFree(db, input, input.effectiveFrom);
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
    validate: (values, before) => {
      checkPayRate(values);
      if (values.effectiveFrom !== undefined && values.effectiveFrom !== before.effectiveFrom) {
        checkRateDateFree(db, before, values.effectiveFrom, before.id);
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
/**
 * `window: null` clears the clock window, going back to the shift type's flag; `consecutive: null`
 * clears a consecutive-shift trigger, `shortRest: null` a short-rest one.
 */
export type DifferentialPatch = Partial<
  Pick<Differential, 'kind' | 'mode' | 'amount' | 'active'>
> & {
  window?: Differential['window'] | null;
  consecutive?: Differential['consecutive'] | null;
  shortRest?: Differential['shortRest'] | null;
};

const DIFFERENTIAL_PATCH_KEYS: PatchKeys<DifferentialPatch> = {
  kind: true,
  mode: true,
  amount: true,
  active: true,
  window: true,
  consecutive: true,
  shortRest: true,
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

/**
 * Refuses a consecutive-shift trigger that cannot be priced, for the same reason as `checkWindow`:
 * a `consecutive_shift` differential without one pays nothing, and one on another kind is ignored.
 * Both numbers are whole shifts and days, at least one each; half a trigger is no trigger.
 */
function checkConsecutive(
  kind: Differential['kind'],
  consecutive: Differential['consecutive'] | undefined,
): void {
  if (consecutive === undefined) {
    if (kind === 'consecutive_shift') {
      throw new Error('A consecutive-shift premium needs its shifts and days');
    }
    return;
  }
  if (kind !== 'consecutive_shift') {
    throw new Error(`Shifts and days apply only to a consecutive-shift premium, not ${kind}`);
  }
  for (const [label, value] of [
    ['shifts', consecutive.afterShifts],
    ['days', consecutive.withinDays],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`The consecutive-shift ${label} must be a whole number of at least 1`);
    }
  }
  checkConsecutiveTiers(consecutive.tiers);
}

/**
 * Refuses tiers pricing cannot read (2025–2030 § G.3 has three: 8s, 10s and 12s). Two tiers for
 * the same shift length would make one of them dead, and every number is a whole hour, shift or day.
 */
function checkConsecutiveTiers(tiers: NonNullable<Differential['consecutive']>['tiers']): void {
  if (tiers === undefined) return;
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 3) {
    throw new Error('A consecutive-shift premium has one to three tiers');
  }
  for (const tier of tiers) {
    for (const [label, value] of [
      ['full-shift hours', tier.fullShiftHours],
      ['shifts', tier.afterShifts],
      ['days', tier.withinDays],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`A tier's ${label} must be a whole number of at least 1`);
      }
    }
  }
  if (new Set(tiers.map((t) => t.fullShiftHours)).size !== tiers.length) {
    throw new Error('Each tier needs its own full-shift length; two tiers have the same hours');
  }
}

const SHORT_REST_SCOPES: readonly string[] = ['whole_shift', 'within_window'];

/**
 * Refuses a short-rest trigger that cannot be priced, as `checkConsecutive` does: a `short_rest`
 * differential without one pays nothing, and one on another kind is ignored. More than a day off
 * is no short turnaround, and a minimum of 0 never pays.
 */
function checkShortRest(
  kind: Differential['kind'],
  shortRest: Differential['shortRest'] | undefined,
): void {
  if (shortRest === undefined) {
    if (kind === 'short_rest') throw new Error('A short-rest premium needs its hours off');
    return;
  }
  if (kind !== 'short_rest') {
    throw new Error(`Hours off apply only to a short-rest premium, not ${kind}`);
  }
  const hours = shortRest.minHoursOff;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error('The hours off must be more than 0 and at most 24');
  }
  if (!SHORT_REST_SCOPES.includes(shortRest.scope)) {
    throw new Error('A short-rest premium is paid on the whole shift or within the window');
  }
}

/**
 * Refuses an amount that would take pay away. Pricing adds `base * (amount - 1)` for a multiplier,
 * so a cleared 1.5x holiday premium saved as 0 would subtract a whole shift's base pay. Exactly 1
 * is allowed: it pays nothing extra but keeps the line visible (the agency premium in the seeds).
 * On-call standby is the exception: it is paid instead of base, at `base * amount`, so the VA's
 * 0.15 (15% of basic pay) is a real rate and only a negative one takes pay away.
 */
function checkAmount(kind: Differential['kind'], mode: Differential['mode'], amount: number): void {
  if (mode === 'multiplier' && kind === 'on_call') {
    if (!(amount >= 0)) throw new Error('An on-call multiplier cannot be negative');
    return;
  }
  if (mode === 'multiplier' && !(amount >= 1)) {
    throw new Error(
      `A multiplier must be 1 or more: 1.5 pays time and a half, and ${amount} would take pay away`,
    );
  }
  if (mode === 'flat' && !(amount >= 0)) throw new Error('A flat differential cannot be negative');
}

/**
 * Refuses a second active differential of a kind on a unit. Core's `differentialOf` pays the first
 * active row of a kind, so a second would show Active and never be paid; a new rate has to wait
 * inactive until the old one is turned off.
 */
function checkOneActive(db: DbLike, unitId: Id, kind: Differential['kind'], exceptId?: Id): void {
  const clash = db
    .select({ id: differential.id })
    .from(differential)
    .where(
      and(
        eq(differential.unitId, unitId),
        eq(differential.kind, kind),
        eq(differential.active, true),
      ),
    )
    .all()
    .some((row) => row.id !== exceptId);
  if (clash) {
    throw new Error(
      `This unit already has an active ${COST_LINE_LABELS[kind].toLowerCase()}, and only one of each kind is paid. Change its amount, or turn it off first.`,
    );
  }
}

const DIFFERENTIAL_KINDS = DIFFERENTIAL_ORDER;

/**
 * IPC input is typed, not checked, and seeds call here directly: refuse what pricing cannot read.
 * A negative amount is left to `checkAmount`, whose message says which kind of negative it is.
 */
function checkDifferentialFields(values: { kind?: unknown; mode?: unknown; amount?: unknown }) {
  if (
    values.kind !== undefined &&
    !(DIFFERENTIAL_KINDS as readonly unknown[]).includes(values.kind)
  ) {
    throw new Error(`A differential's kind must be one of ${DIFFERENTIAL_KINDS.join(', ')}.`);
  }
  if (values.mode !== undefined && values.mode !== 'multiplier' && values.mode !== 'flat') {
    throw new Error('A differential is a multiplier or a flat amount.');
  }
  if (
    values.amount !== undefined &&
    !(typeof values.amount === 'number' && Number.isFinite(values.amount))
  ) {
    throw new Error('A differential amount must be a number, zero or more.');
  }
}

function consecutiveColumns(consecutive: Differential['consecutive'] | undefined) {
  return {
    consecutiveAfterShifts: consecutive?.afterShifts ?? null,
    consecutiveWithinDays: consecutive?.withinDays ?? null,
    consecutiveTiers: consecutive?.tiers === undefined ? null : JSON.stringify(consecutive.tiers),
  };
}

function shortRestColumns(shortRest: Differential['shortRest'] | undefined) {
  return {
    shortRestMinHoursOff: shortRest?.minHoursOff ?? null,
    shortRestScope: shortRest?.scope ?? null,
  };
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
  checkDifferentialFields(input);
  checkWindow(input.kind, input.window);
  checkConsecutive(input.kind, input.consecutive);
  checkShortRest(input.kind, input.shortRest);
  checkAmount(input.kind, input.mode, input.amount);
  if (input.active) checkOneActive(db, input.unitId, input.kind);
  const id = ids.differential();
  const { window, consecutive, shortRest, ...rest } = input;
  const row = {
    id,
    ...rest,
    ...windowColumns(window),
    ...consecutiveColumns(consecutive),
    ...shortRestColumns(shortRest),
  };
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
      checkDifferentialFields(values);
      const window = values.window === undefined ? before.window : (values.window ?? undefined);
      checkWindow(values.kind ?? before.kind, window);
      const consecutive =
        values.consecutive === undefined ? before.consecutive : (values.consecutive ?? undefined);
      checkConsecutive(values.kind ?? before.kind, consecutive);
      const shortRest =
        values.shortRest === undefined ? before.shortRest : (values.shortRest ?? undefined);
      checkShortRest(values.kind ?? before.kind, shortRest);
      checkAmount(
        values.kind ?? before.kind,
        values.mode ?? before.mode,
        values.amount ?? before.amount,
      );
      // An untouched active row is already the one paid; only becoming active or changing kind
      // can make it a second.
      const active = values.active ?? before.active;
      if (active && (values.active === true || values.kind !== undefined)) {
        checkOneActive(db, before.unitId, values.kind ?? before.kind, before.id);
      }
    },
    write: (rowId, values) => {
      const { window, consecutive, shortRest, ...columns } = values;
      db.update(differential)
        .set({
          ...columns,
          ...(window === undefined ? {} : windowColumns(window ?? undefined)),
          ...(consecutive === undefined ? {} : consecutiveColumns(consecutive ?? undefined)),
          ...(shortRest === undefined ? {} : shortRestColumns(shortRest ?? undefined)),
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
/** `null` for `pyramiding`, `minimumMinutes`, `scheduleKinds` or `tourDays` clears it. */
export type OvertimeRulePatch = Partial<
  Pick<OvertimeRule, 'basis' | 'thresholdHours' | 'multiplier' | 'active'>
> & {
  pyramiding?: 'stack' | 'none' | null;
  minimumMinutes?: number | null;
  scheduleKinds?: ScheduleKind[] | null;
  tourDays?: 'only' | 'except' | null;
};

const OVERTIME_RULE_PATCH_KEYS: PatchKeys<OvertimeRulePatch> = {
  basis: true,
  thresholdHours: true,
  multiplier: true,
  active: true,
  pyramiding: true,
  minimumMinutes: true,
  scheduleKinds: true,
  tourDays: true,
};

// A Record keyed by the union makes a basis added to the entity a compile error here.
const OVERTIME_BASIS_SET: Record<OvertimeRule['basis'], true> = {
  daily: true,
  weekly: true,
  pay_period: true,
  seventh_day: true,
  beyond_scheduled_tour: true,
  consecutive: true,
  beyond_scheduled_days: true,
  weekend: true,
};
const OVERTIME_BASES: readonly string[] = Object.keys(OVERTIME_BASIS_SET);

/** IPC input is typed, not checked, and seeds call here directly: refuse what pricing cannot read. */
function checkOvertimeOptions(values: {
  basis?: string | undefined;
  thresholdHours?: number | undefined;
  multiplier?: number | undefined;
  pyramiding?: string | null | undefined;
  minimumMinutes?: number | null | undefined;
  scheduleKinds?: readonly string[] | null | undefined;
  tourDays?: string | null | undefined;
}): void {
  const { pyramiding, minimumMinutes, scheduleKinds, tourDays } = values;
  if (values.basis !== undefined && !OVERTIME_BASES.includes(values.basis)) {
    throw new Error(`An overtime rule's basis must be one of ${OVERTIME_BASES.join(', ')}.`);
  }
  if (
    values.thresholdHours !== undefined &&
    !(Number.isFinite(values.thresholdHours) && values.thresholdHours >= 0)
  ) {
    throw new Error('An overtime threshold must be a number of hours, zero or more.');
  }
  if (
    values.multiplier !== undefined &&
    !(Number.isFinite(values.multiplier) && values.multiplier >= 1)
  ) {
    throw new Error('An overtime multiplier must be 1 or more.');
  }
  if (pyramiding != null && pyramiding !== 'stack' && pyramiding !== 'none') {
    throw new Error('Pyramiding must be stack or none');
  }
  if (
    minimumMinutes != null &&
    !(Number.isInteger(minimumMinutes) && minimumMinutes >= 0 && minimumMinutes <= 240)
  ) {
    throw new Error('The overtime minimum must be a whole number of minutes from 0 to 240');
  }
  if (
    scheduleKinds != null &&
    !(
      Array.isArray(scheduleKinds) &&
      scheduleKinds.length > 0 &&
      new Set(scheduleKinds).size === scheduleKinds.length &&
      scheduleKinds.every((k) => (SCHEDULE_KINDS as readonly string[]).includes(k))
    )
  ) {
    throw new Error(
      `Overtime rule schedule kinds must be one or more of ${SCHEDULE_KINDS.join(', ')}`,
    );
  }
  if (tourDays != null && tourDays !== 'only' && tourDays !== 'except') {
    throw new Error('Tour days must be only or except');
  }
  if (tourDays != null && values.basis !== 'daily') {
    throw new Error('Tour days apply only to a daily overtime rule');
  }
}

export function createOvertimeRule(
  db: DbLike,
  input: OvertimeRuleInput,
  actor: string,
): OvertimeRule {
  checkOvertimeOptions(input);
  const id = ids.overtimeRule();
  const row = {
    id,
    ...input,
    pyramiding: input.pyramiding ?? null,
    minimumMinutes: input.minimumMinutes ?? null,
    scheduleKinds: input.scheduleKinds ? [...input.scheduleKinds] : null,
    tourDays: input.tourDays ?? null,
  };
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
    write: (rowId, values) =>
      db.update(overtimeRule).set(values).where(eq(overtimeRule.id, rowId)).run(),
    // Tour days are judged against the basis the rule will have, so a patch that moves a rule off
    // 'daily' cannot leave a tour-day filter behind that nothing reads.
    validate: (values, before) =>
      checkOvertimeOptions({
        ...values,
        basis: values.basis ?? before.basis,
        tourDays: values.tourDays !== undefined ? values.tourDays : before.tourDays,
      }),
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
  if (!(Number.isFinite(targetDollars) && targetDollars >= 0)) {
    throw new Error('A budget must be a number of dollars, zero or more.');
  }
  const period = db
    .select({ unitId: schedulePeriod.unitId })
    .from(schedulePeriod)
    .where(eq(schedulePeriod.id, periodId))
    .get();
  if (!period) throw new Error('That schedule period was not found. Reload the page.');
  if (period.unitId !== unitId) throw new Error('That schedule period is not on this unit.');
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

// Core owns the shape and the defaults so a preset can propose settings without the db's help.
export type { PaySettings } from '@shiftnurse/core';
export { DEFAULT_PAY_SETTINGS } from '@shiftnurse/core';

/** A unit that has saved nothing is paid by the defaults. */
export function getPaySettings(db: DbLike, unitId: Id): PaySettings {
  const row = db.select().from(paySettings).where(eq(paySettings.unitId, unitId)).get();
  return row
    ? {
        callBackMinimumHours: row.callBackMinimumHours,
        premiumStacking: row.premiumStacking ?? 'compound',
        holidayPayCoversOvertime: row.holidayPayCoversOvertime ?? false,
        // A row saved before migration 0037 has no notice; D13's default is 2 hours.
        reportingPayNoticeHours: row.reportingPayNoticeHours ?? 2,
        // A row saved before migration 0047 has no attribution; D17's default is the clock.
        overtimeWindowAttribution: row.overtimeWindowAttribution ?? 'clock',
        // Rows saved before migration 0052 pay the spring night as worked and breaks at base.
        paySpringForwardAsScheduled: row.paySpringForwardAsScheduled ?? false,
        breakPremiumRate: row.breakPremiumRate ?? 'base',
        // Rows saved before migration 0054 have no rate: comp time is off.
        compTime:
          row.compTimeHoursPerOvertimeHour === null
            ? null
            : {
                hoursPerOvertimeHour: row.compTimeHoursPerOvertimeHour,
                capHours: row.compTimeCapHours ?? null,
              },
      }
    : { ...DEFAULT_PAY_SETTINGS };
}

/**
 * Whether the unit has a pay-settings row. The preset proposes settings only to a unit that never
 * saved any: a saved row may follow a contract the preset cannot see, and `getPaySettings` cannot
 * tell "saved the defaults" from "saved nothing".
 */
export function paySettingsSaved(db: DbLike, unitId: Id): boolean {
  return (
    db
      .select({ unitId: paySettings.unitId })
      .from(paySettings)
      .where(eq(paySettings.unitId, unitId))
      .get() !== undefined
  );
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
  const stacking = settings.premiumStacking;
  if (stacking !== 'compound' && stacking !== 'additive') {
    throw new Error('Premium stacking must be compound or additive');
  }
  const notice = settings.reportingPayNoticeHours;
  if (!Number.isFinite(notice) || notice < 0 || notice > 24) {
    throw new Error('The reporting-pay notice must be between 0 and 24 hours');
  }
  const attribution = settings.overtimeWindowAttribution;
  if (attribution !== 'clock' && attribution !== 'start') {
    throw new Error(
      'Choose whether a shift that crosses into a new work week counts each hour in the week it is worked or the whole shift in the week it starts.',
    );
  }
  const breakRate = settings.breakPremiumRate;
  if (breakRate !== 'base' && breakRate !== 'regular') {
    throw new Error('Choose whether a missed break is paid at the base rate or the regular rate.');
  }
  // IPC input is typed, not checked: a rate under one would bank fewer hours than were worked.
  const compTime = settings.compTime ?? null;
  if (compTime) {
    if (!Number.isFinite(compTime.hoursPerOvertimeHour) || compTime.hoursPerOvertimeHour < 1) {
      throw new Error('Comp time must bank at least one hour per overtime hour.');
    }
    if (
      compTime.capHours !== null &&
      !(Number.isFinite(compTime.capHours) && compTime.capHours > 0)
    ) {
      throw new Error(
        'The most comp hours a nurse may hold must be more than zero, or blank for no cap.',
      );
    }
  }
  const compRate = compTime?.hoursPerOvertimeHour ?? null;
  const compCap = compTime?.capHours ?? null;
  const springAsScheduled = settings.paySpringForwardAsScheduled === true;
  // A unit with no row has no stored settings: reading defaults as "before" would audit state
  // that never existed.
  const saved = paySettingsSaved(db, unitId);
  const before = saved ? getPaySettings(db, unitId) : undefined;
  const covers = settings.holidayPayCoversOvertime === true;
  const after: PaySettings = {
    callBackMinimumHours: hours,
    premiumStacking: stacking,
    holidayPayCoversOvertime: covers,
    reportingPayNoticeHours: notice,
    overtimeWindowAttribution: attribution,
    paySpringForwardAsScheduled: springAsScheduled,
    breakPremiumRate: breakRate,
    compTime: compTime ? { ...compTime } : null,
  };
  db.insert(paySettings)
    .values({
      unitId,
      callBackMinimumHours: hours,
      premiumStacking: stacking,
      holidayPayCoversOvertime: covers,
      reportingPayNoticeHours: notice,
      overtimeWindowAttribution: attribution,
      paySpringForwardAsScheduled: springAsScheduled,
      breakPremiumRate: breakRate,
      compTimeHoursPerOvertimeHour: compRate,
      compTimeCapHours: compCap,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: paySettings.unitId,
      set: {
        callBackMinimumHours: hours,
        premiumStacking: stacking,
        holidayPayCoversOvertime: covers,
        reportingPayNoticeHours: notice,
        overtimeWindowAttribution: attribution,
        paySpringForwardAsScheduled: springAsScheduled,
        breakPremiumRate: breakRate,
        compTimeHoursPerOvertimeHour: compRate,
        compTimeCapHours: compCap,
        updatedAt: Date.now(),
      },
    })
    .run();
  recordAudit(db, {
    entityType: 'pay_settings',
    entityId: unitId,
    action: saved ? 'update' : 'create',
    actor,
    ...(before ? { before } : {}),
    after,
  });
  return after;
}

/** Removes a period's budget. Nothing to remove writes nothing, so the audit trail has no no-ops. */
export function clearBudget(db: DbLike, periodId: Id, actor: string): void {
  const row = db.select().from(budget).where(eq(budget.periodId, periodId)).get();
  if (!row) return;
  const before = toBudget(row);
  db.delete(budget).where(eq(budget.id, row.id)).run();
  recordAudit(db, { entityType: 'budget', entityId: row.id, action: 'delete', actor, before });
}
