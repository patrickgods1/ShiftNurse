/**
 * Acuity configuration: the unit's acuity tiers, the patient-ratio rules keyed on them, and the
 * HPPD target. Together with census these are what `deriveDemand` turns into required staff.
 */

import type { AcuityTier, HppdTarget, Id, NurseRole, RatioRule } from '@shiftnurse/core';
import { and, asc, eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toAcuityTier, toRatioRule } from '../mappers.js';
import {
  acuityTier as acuityTierTable,
  hppdTarget as hppdTargetTable,
  ratioRule as ratioRuleTable,
} from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

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

const ACUITY_TIER_PATCH_KEYS: PatchKeys<AcuityTierPatch> = {
  name: true,
  level: true,
  careHoursPerPatientDay: true,
};

export function updateAcuityTier(
  db: DbLike,
  id: Id,
  patch: AcuityTierPatch,
  actor: string,
): AcuityTier {
  const row = db.select().from(acuityTierTable).where(eq(acuityTierTable.id, id)).get();
  if (!row) throw new Error(`Acuity tier ${id} not found`);
  const before = toAcuityTier(row);
  const merged = { ...row, ...patchOf(patch, ACUITY_TIER_PATCH_KEYS, 'acuity tier') };
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

const RATIO_RULE_PATCH_KEYS: PatchKeys<RatioRulePatch> = {
  role: true,
  acuityTierId: true,
  maxPatientsPerNurse: true,
  citation: true,
  active: true,
};

export function updateRatioRule(
  db: DbLike,
  id: Id,
  patch: RatioRulePatch,
  actor: string,
): RatioRule {
  const row = db.select().from(ratioRuleTable).where(eq(ratioRuleTable.id, id)).get();
  if (!row) throw new Error(`Ratio rule ${id} not found`);
  const before = toRatioRule(row);
  const merged = { ...row, ...patchOf(patch, RATIO_RULE_PATCH_KEYS, 'ratio rule') };
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
