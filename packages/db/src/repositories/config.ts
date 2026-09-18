/**
 * Unit configuration repository: the unit itself, shift types, staffing rules (coverage,
 * acuity, ratios, HPPD), holidays, shift credential requirements and rule sets.
 *
 * This is the slowest-moving data in the system — a manager edits it a handful of times a
 * year — but it is what every solve and every compliance report is judged against, so reads
 * here favour returning a complete, ready-to-use shape (see `getRuleSet`/`getLatestRuleSet`)
 * over a thin row projection the caller has to reassemble itself.
 */

import type {
  AcuityTier,
  CoverageRequirement,
  Holiday,
  HppdTarget,
  Id,
  IsoDate,
  NurseRole,
  RatioRule,
  RuleConfig,
  RuleSet,
  ShiftCredentialRequirement,
  ShiftType,
  Unit,
  WeekendDefinition,
} from '@shiftnurse/core';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import {
  toAcuityTier,
  toCoverageRequirement,
  toCredentialRequirement,
  toHoliday,
  toRatioRule,
  toShiftType,
  toUnit,
} from '../mappers.js';
import {
  acuityTier as acuityTierTable,
  coverageRequirement as coverageRequirementTable,
  holiday as holidayTable,
  hppdTarget as hppdTargetTable,
  ratioRule as ratioRuleTable,
  ruleConfig as ruleConfigTable,
  ruleSet as ruleSetTable,
  shiftCredentialRequirement as shiftCredentialRequirementTable,
  shiftType as shiftTypeTable,
  unit as unitTable,
} from '../schema.js';

/** Drop keys the caller left `undefined`, so a partial patch only touches fields it sets. */
function compact<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export function listUnits(db: DbLike): Unit[] {
  return db.select().from(unitTable).orderBy(asc(unitTable.name)).all().map(toUnit);
}

export function getUnit(db: DbLike, id: Id): Unit | undefined {
  const row = db.select().from(unitTable).where(eq(unitTable.id, id)).get();
  return row ? toUnit(row) : undefined;
}

export function createUnit(db: DbLike, input: Omit<Unit, 'id'>, actor: string): Unit {
  const id = ids.unit();
  const row: typeof unitTable.$inferInsert = { id, ...input };
  db.insert(unitTable).values(row).run();
  const after = toUnit(row as typeof unitTable.$inferSelect);
  recordAudit(db, { entityType: 'unit', entityId: id, action: 'create', actor, after });
  return after;
}

export interface UnitPatch {
  name?: string;
  unitType?: string;
  payPeriodDays?: number;
  payPeriodAnchor?: IsoDate;
}

export function updateUnit(db: DbLike, id: Id, patch: UnitPatch, actor: string): Unit {
  const row = db.select().from(unitTable).where(eq(unitTable.id, id)).get();
  if (!row) throw new Error(`Unit ${id} not found`);
  const before = toUnit(row);
  const merged = { ...row, ...compact(patch) };
  db.update(unitTable).set(merged).where(eq(unitTable.id, id)).run();
  const after = toUnit(merged);
  recordAudit(db, { entityType: 'unit', entityId: id, action: 'update', actor, before, after });
  return after;
}

// ---------------------------------------------------------------------------
// Shift types
// ---------------------------------------------------------------------------

export function listShiftTypesForUnit(db: DbLike, unitId: Id): ShiftType[] {
  return db
    .select()
    .from(shiftTypeTable)
    .where(eq(shiftTypeTable.unitId, unitId))
    .orderBy(asc(shiftTypeTable.sortOrder))
    .all()
    .map(toShiftType);
}

export function getShiftType(db: DbLike, id: Id): ShiftType | undefined {
  const row = db.select().from(shiftTypeTable).where(eq(shiftTypeTable.id, id)).get();
  return row ? toShiftType(row) : undefined;
}

export function createShiftType(
  db: DbLike,
  input: Omit<ShiftType, 'id'>,
  actor: string,
): ShiftType {
  const id = ids.shiftType();
  const row: typeof shiftTypeTable.$inferInsert = { id, ...input };
  db.insert(shiftTypeTable).values(row).run();
  const after = toShiftType(row as typeof shiftTypeTable.$inferSelect);
  recordAudit(db, { entityType: 'shift_type', entityId: id, action: 'create', actor, after });
  return after;
}

export interface ShiftTypePatch {
  name?: string;
  abbreviation?: string;
  startTime?: string;
  durationHours?: number;
  isNight?: boolean;
  isOnCall?: boolean;
  color?: string;
  sortOrder?: number;
  active?: boolean;
}

export function updateShiftType(
  db: DbLike,
  id: Id,
  patch: ShiftTypePatch,
  actor: string,
): ShiftType {
  const row = db.select().from(shiftTypeTable).where(eq(shiftTypeTable.id, id)).get();
  if (!row) throw new Error(`Shift type ${id} not found`);
  const before = toShiftType(row);
  const merged = { ...row, ...compact(patch) };
  db.update(shiftTypeTable).set(merged).where(eq(shiftTypeTable.id, id)).run();
  const after = toShiftType(merged);
  recordAudit(db, {
    entityType: 'shift_type',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

/**
 * Deactivate rather than delete: past periods, assignments and coverage requirements still
 * reference this shift type, and deleting it would either cascade away that history or leave
 * those rows pointing at nothing.
 */
export function deactivateShiftType(db: DbLike, id: Id, actor: string): ShiftType {
  const row = db.select().from(shiftTypeTable).where(eq(shiftTypeTable.id, id)).get();
  if (!row) throw new Error(`Shift type ${id} not found`);
  const before = toShiftType(row);
  const merged = { ...row, active: false };
  db.update(shiftTypeTable).set(merged).where(eq(shiftTypeTable.id, id)).run();
  const after = toShiftType(merged);
  recordAudit(db, {
    entityType: 'shift_type',
    entityId: id,
    action: 'delete',
    actor,
    before,
    after,
  });
  return after;
}

// ---------------------------------------------------------------------------
// Coverage requirements
// ---------------------------------------------------------------------------

export function listCoverageRequirementsForUnit(db: DbLike, unitId: Id): CoverageRequirement[] {
  return db
    .select()
    .from(coverageRequirementTable)
    .where(eq(coverageRequirementTable.unitId, unitId))
    .all()
    .map(toCoverageRequirement);
}

export function listCoverageRequirementsForShiftType(
  db: DbLike,
  shiftTypeId: Id,
): CoverageRequirement[] {
  return db
    .select()
    .from(coverageRequirementTable)
    .where(eq(coverageRequirementTable.shiftTypeId, shiftTypeId))
    .all()
    .map(toCoverageRequirement);
}

/** Create when `input.id` is absent, otherwise update the existing row in place. */
export function upsertCoverageRequirement(
  db: DbLike,
  input: Omit<CoverageRequirement, 'id'> & { id?: Id },
  actor: string,
): CoverageRequirement {
  if (input.id !== undefined) {
    const row = db
      .select()
      .from(coverageRequirementTable)
      .where(eq(coverageRequirementTable.id, input.id))
      .get();
    if (!row) throw new Error(`Coverage requirement ${input.id} not found`);
    const before = toCoverageRequirement(row);
    const merged = {
      ...row,
      shiftTypeId: input.shiftTypeId,
      weekday: input.weekday,
      date: input.date,
      role: input.role,
      minCount: input.minCount,
      targetCount: input.targetCount,
    };
    db.update(coverageRequirementTable)
      .set(merged)
      .where(eq(coverageRequirementTable.id, input.id))
      .run();
    const after = toCoverageRequirement(merged);
    recordAudit(db, {
      entityType: 'coverage_requirement',
      entityId: input.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }
  const id = ids.coverage();
  const row: typeof coverageRequirementTable.$inferInsert = {
    id,
    unitId: input.unitId,
    shiftTypeId: input.shiftTypeId,
    weekday: input.weekday,
    date: input.date,
    role: input.role,
    minCount: input.minCount,
    targetCount: input.targetCount,
  };
  db.insert(coverageRequirementTable).values(row).run();
  const after = toCoverageRequirement(row as typeof coverageRequirementTable.$inferSelect);
  recordAudit(db, {
    entityType: 'coverage_requirement',
    entityId: id,
    action: 'create',
    actor,
    after,
  });
  return after;
}

export function deleteCoverageRequirement(db: DbLike, id: Id, actor: string): void {
  const row = db
    .select()
    .from(coverageRequirementTable)
    .where(eq(coverageRequirementTable.id, id))
    .get();
  if (!row) throw new Error(`Coverage requirement ${id} not found`);
  const before = toCoverageRequirement(row);
  db.delete(coverageRequirementTable).where(eq(coverageRequirementTable.id, id)).run();
  recordAudit(db, {
    entityType: 'coverage_requirement',
    entityId: id,
    action: 'delete',
    actor,
    before,
  });
}

// ---------------------------------------------------------------------------
// Acuity tiers
// ---------------------------------------------------------------------------

export function listAcuityTiersForUnit(db: DbLike, unitId: Id): AcuityTier[] {
  return db
    .select()
    .from(acuityTierTable)
    .where(eq(acuityTierTable.unitId, unitId))
    .orderBy(asc(acuityTierTable.level))
    .all()
    .map(toAcuityTier);
}

export function createAcuityTier(
  db: DbLike,
  input: Omit<AcuityTier, 'id'>,
  actor: string,
): AcuityTier {
  const id = ids.acuityTier();
  const row: typeof acuityTierTable.$inferInsert = { id, ...input };
  db.insert(acuityTierTable).values(row).run();
  const after = toAcuityTier(row as typeof acuityTierTable.$inferSelect);
  recordAudit(db, { entityType: 'acuity_tier', entityId: id, action: 'create', actor, after });
  return after;
}

export interface AcuityTierPatch {
  name?: string;
  level?: number;
  careHoursPerPatientDay?: number;
}

export function updateAcuityTier(
  db: DbLike,
  id: Id,
  patch: AcuityTierPatch,
  actor: string,
): AcuityTier {
  const row = db.select().from(acuityTierTable).where(eq(acuityTierTable.id, id)).get();
  if (!row) throw new Error(`Acuity tier ${id} not found`);
  const before = toAcuityTier(row);
  const merged = { ...row, ...compact(patch) };
  db.update(acuityTierTable).set(merged).where(eq(acuityTierTable.id, id)).run();
  const after = toAcuityTier(merged);
  recordAudit(db, {
    entityType: 'acuity_tier',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

export function deleteAcuityTier(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(acuityTierTable).where(eq(acuityTierTable.id, id)).get();
  if (!row) throw new Error(`Acuity tier ${id} not found`);
  const before = toAcuityTier(row);
  db.delete(acuityTierTable).where(eq(acuityTierTable.id, id)).run();
  recordAudit(db, { entityType: 'acuity_tier', entityId: id, action: 'delete', actor, before });
}

// ---------------------------------------------------------------------------
// Ratio rules
// ---------------------------------------------------------------------------

/** Every rule including deactivated ones — the editor shows history, the solver does not. */
export function listRatioRulesForUnit(db: DbLike, unitId: Id): RatioRule[] {
  return db
    .select()
    .from(ratioRuleTable)
    .where(eq(ratioRuleTable.unitId, unitId))
    .all()
    .map(toRatioRule);
}

export function listActiveRatioRulesForUnit(db: DbLike, unitId: Id): RatioRule[] {
  return db
    .select()
    .from(ratioRuleTable)
    .where(and(eq(ratioRuleTable.unitId, unitId), eq(ratioRuleTable.active, true)))
    .all()
    .map(toRatioRule);
}

export function createRatioRule(
  db: DbLike,
  input: Omit<RatioRule, 'id'>,
  actor: string,
): RatioRule {
  const id = ids.ratioRule();
  const row: typeof ratioRuleTable.$inferInsert = {
    id,
    unitId: input.unitId,
    role: input.role,
    acuityTierId: input.acuityTierId,
    maxPatientsPerNurse: input.maxPatientsPerNurse,
    citation: input.citation ?? null,
    active: input.active,
  };
  db.insert(ratioRuleTable).values(row).run();
  const after = toRatioRule(row as typeof ratioRuleTable.$inferSelect);
  recordAudit(db, { entityType: 'ratio_rule', entityId: id, action: 'create', actor, after });
  return after;
}

export interface RatioRulePatch {
  role?: NurseRole;
  acuityTierId?: Id | null;
  maxPatientsPerNurse?: number;
  citation?: string | null;
  active?: boolean;
}

export function updateRatioRule(
  db: DbLike,
  id: Id,
  patch: RatioRulePatch,
  actor: string,
): RatioRule {
  const row = db.select().from(ratioRuleTable).where(eq(ratioRuleTable.id, id)).get();
  if (!row) throw new Error(`Ratio rule ${id} not found`);
  const before = toRatioRule(row);
  const merged = { ...row, ...compact(patch) };
  db.update(ratioRuleTable).set(merged).where(eq(ratioRuleTable.id, id)).run();
  const after = toRatioRule(merged);
  recordAudit(db, {
    entityType: 'ratio_rule',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

/** Deactivate rather than delete: past periods were solved under this rule and must stay explainable. */
export function deactivateRatioRule(db: DbLike, id: Id, actor: string): RatioRule {
  const row = db.select().from(ratioRuleTable).where(eq(ratioRuleTable.id, id)).get();
  if (!row) throw new Error(`Ratio rule ${id} not found`);
  const before = toRatioRule(row);
  const merged = { ...row, active: false };
  db.update(ratioRuleTable).set(merged).where(eq(ratioRuleTable.id, id)).run();
  const after = toRatioRule(merged);
  recordAudit(db, {
    entityType: 'ratio_rule',
    entityId: id,
    action: 'delete',
    actor,
    before,
    after,
  });
  return after;
}

// ---------------------------------------------------------------------------
// HPPD target
// ---------------------------------------------------------------------------

function toHppdTarget(r: typeof hppdTargetTable.$inferSelect): HppdTarget {
  return { id: r.id, unitId: r.unitId, targetHours: r.targetHours };
}

export function getHppdTarget(db: DbLike, unitId: Id): HppdTarget | undefined {
  const row = db.select().from(hppdTargetTable).where(eq(hppdTargetTable.unitId, unitId)).get();
  return row ? toHppdTarget(row) : undefined;
}

/** One target per unit. Updates the existing row if present, otherwise creates it. */
export function upsertHppdTarget(
  db: DbLike,
  unitId: Id,
  targetHours: number,
  actor: string,
): HppdTarget {
  const row = db.select().from(hppdTargetTable).where(eq(hppdTargetTable.unitId, unitId)).get();
  if (row) {
    const before = toHppdTarget(row);
    const merged = { ...row, targetHours };
    db.update(hppdTargetTable).set(merged).where(eq(hppdTargetTable.id, row.id)).run();
    const after = toHppdTarget(merged);
    recordAudit(db, {
      entityType: 'hppd_target',
      entityId: row.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }
  const id = ids.hppdTarget();
  const newRow: typeof hppdTargetTable.$inferInsert = { id, unitId, targetHours };
  db.insert(hppdTargetTable).values(newRow).run();
  const after = toHppdTarget(newRow as typeof hppdTargetTable.$inferSelect);
  recordAudit(db, { entityType: 'hppd_target', entityId: id, action: 'create', actor, after });
  return after;
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export function listHolidaysForUnit(db: DbLike, unitId: Id): Holiday[] {
  return db.select().from(holidayTable).where(eq(holidayTable.unitId, unitId)).all().map(toHoliday);
}

export function listHolidaysInRange(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): Holiday[] {
  return db
    .select()
    .from(holidayTable)
    .where(
      and(
        eq(holidayTable.unitId, unitId),
        gte(holidayTable.date, start),
        lte(holidayTable.date, end),
      ),
    )
    .all()
    .map(toHoliday);
}

export function createHoliday(db: DbLike, input: Omit<Holiday, 'id'>, actor: string): Holiday {
  const id = ids.holiday();
  const row: typeof holidayTable.$inferInsert = { id, ...input };
  db.insert(holidayTable).values(row).run();
  const after = toHoliday(row as typeof holidayTable.$inferSelect);
  recordAudit(db, { entityType: 'holiday', entityId: id, action: 'create', actor, after });
  return after;
}

export function deleteHoliday(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(holidayTable).where(eq(holidayTable.id, id)).get();
  if (!row) throw new Error(`Holiday ${id} not found`);
  const before = toHoliday(row);
  db.delete(holidayTable).where(eq(holidayTable.id, id)).run();
  recordAudit(db, { entityType: 'holiday', entityId: id, action: 'delete', actor, before });
}

// ---------------------------------------------------------------------------
// Shift credential requirements
// ---------------------------------------------------------------------------

export function listShiftCredentialRequirementsForUnit(
  db: DbLike,
  unitId: Id,
): ShiftCredentialRequirement[] {
  return db
    .select()
    .from(shiftCredentialRequirementTable)
    .where(eq(shiftCredentialRequirementTable.unitId, unitId))
    .all()
    .map(toCredentialRequirement);
}

export function createShiftCredentialRequirement(
  db: DbLike,
  input: Omit<ShiftCredentialRequirement, 'id'>,
  actor: string,
): ShiftCredentialRequirement {
  const id = ids.credentialRequirement();
  const row: typeof shiftCredentialRequirementTable.$inferInsert = { id, ...input };
  db.insert(shiftCredentialRequirementTable).values(row).run();
  const after = toCredentialRequirement(row as typeof shiftCredentialRequirementTable.$inferSelect);
  recordAudit(db, {
    entityType: 'shift_credential_requirement',
    entityId: id,
    action: 'create',
    actor,
    after,
  });
  return after;
}

export function deleteShiftCredentialRequirement(db: DbLike, id: Id, actor: string): void {
  const row = db
    .select()
    .from(shiftCredentialRequirementTable)
    .where(eq(shiftCredentialRequirementTable.id, id))
    .get();
  if (!row) throw new Error(`Shift credential requirement ${id} not found`);
  const before = toCredentialRequirement(row);
  db.delete(shiftCredentialRequirementTable)
    .where(eq(shiftCredentialRequirementTable.id, id))
    .run();
  recordAudit(db, {
    entityType: 'shift_credential_requirement',
    entityId: id,
    action: 'delete',
    actor,
    before,
  });
}

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

function toRuleConfig(r: typeof ruleConfigTable.$inferSelect): RuleConfig {
  return {
    ruleId: r.ruleId,
    enabled: r.enabled,
    severityOverride: r.severityOverride ?? undefined,
    params: r.params,
  };
}

function assembleRuleSet(db: DbLike, row: typeof ruleSetTable.$inferSelect): RuleSet {
  const configRows = db
    .select()
    .from(ruleConfigTable)
    .where(eq(ruleConfigTable.ruleSetId, row.id))
    .all();
  return {
    id: row.id,
    unitId: row.unitId,
    name: row.name,
    version: row.version,
    configs: configRows.map(toRuleConfig),
    weekendDefinition: row.weekendDefinition as WeekendDefinition,
    createdAt: row.createdAt,
  };
}

export function getRuleSet(db: DbLike, id: Id): RuleSet | undefined {
  const row = db.select().from(ruleSetTable).where(eq(ruleSetTable.id, id)).get();
  return row ? assembleRuleSet(db, row) : undefined;
}

/** The highest-`version` rule set for a unit — the rules currently in force. */
export function getLatestRuleSet(db: DbLike, unitId: Id): RuleSet | undefined {
  const row = db
    .select()
    .from(ruleSetTable)
    .where(eq(ruleSetTable.unitId, unitId))
    .orderBy(desc(ruleSetTable.version))
    .limit(1)
    .get();
  return row ? assembleRuleSet(db, row) : undefined;
}

/**
 * Save a rule set as a brand-new, immutable version rather than editing the latest one in
 * place. A published `SchedulePeriod` snapshots the `ruleSetVersion` it was solved under, so
 * a manager tightening the rest-rule tomorrow must never silently rewrite the rules an
 * already-published schedule was judged by — that would make the schedule's own compliance
 * report describe rules that were never actually in force when it ran. Editing rules always
 * produces version N+1; version N is retained forever.
 */
export function saveRuleSet(
  db: DbLike,
  draft: Pick<RuleSet, 'unitId' | 'name' | 'configs' | 'weekendDefinition'>,
  actor: string,
): RuleSet {
  const latest = getLatestRuleSet(db, draft.unitId);
  const id = ids.ruleSet();
  const version = (latest?.version ?? 0) + 1;
  const createdAt = Date.now();
  const row: typeof ruleSetTable.$inferInsert = {
    id,
    unitId: draft.unitId,
    name: draft.name,
    version,
    weekendDefinition: draft.weekendDefinition,
    createdAt,
  };
  db.insert(ruleSetTable).values(row).run();
  if (draft.configs.length > 0) {
    db.insert(ruleConfigTable)
      .values(
        draft.configs.map((c) => ({
          ruleSetId: id,
          ruleId: c.ruleId,
          enabled: c.enabled,
          severityOverride: c.severityOverride ?? null,
          params: c.params,
        })),
      )
      .run();
  }
  const after: RuleSet = {
    id,
    unitId: draft.unitId,
    name: draft.name,
    version,
    configs: draft.configs,
    weekendDefinition: draft.weekendDefinition,
    createdAt,
  };
  recordAudit(db, { entityType: 'rule_set', entityId: id, action: 'create', actor, after });
  return after;
}
