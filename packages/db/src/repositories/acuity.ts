/**
 * Acuity configuration: the unit's acuity tiers, the patient-ratio rules keyed on them, and the
 * HPPD target. Together with census these are what `deriveDemand` turns into required staff.
 *
 * A tier that a ratio rule (active or deactivated) or a census day's mix cites cannot be deleted:
 * the rule FK cascades and the census mix is a JSON map with no FK, so a delete would silently
 * drop the rules and leave those patients counted against no ratio, i.e. demand of zero.
 */

import type { AcuityTier, HppdTarget, Id, RatioRole, RatioRule } from '@shiftnurse/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toAcuityTier, toRatioRule } from '../mappers.js';
import {
  acuityTier as acuityTierTable,
  censusForecast as censusForecastTable,
  hppdTarget as hppdTargetTable,
  ratioRule as ratioRuleTable,
} from '../schema.js';
import { auditedUpdate, type PatchKeys } from './patch.js';

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
  return auditedUpdate<AcuityTier, AcuityTierPatch>(db, {
    id,
    entityType: 'acuity_tier',
    entityLabel: 'acuity tier',
    allowed: ACUITY_TIER_PATCH_KEYS,
    patch,
    read: (rowId) => {
      const row = db.select().from(acuityTierTable).where(eq(acuityTierTable.id, rowId)).get();
      return row ? toAcuityTier(row) : undefined;
    },
    write: (rowId, values) =>
      db.update(acuityTierTable).set(values).where(eq(acuityTierTable.id, rowId)).run(),
    notFound: `Acuity tier ${id} not found`,
    actor,
  });
}

/** The refusal text: one clause per kind of citation, singular for one. */
function citedMessage(name: string, rules: number, days: number): string {
  const cited: string[] = [];
  if (rules > 0) {
    cited.push(`${rules} ratio rule${rules === 1 ? '' : 's'} (deactivated ones included)`);
  }
  if (days > 0) cited.push(`${days} census day${days === 1 ? '' : 's'}`);
  const consequences: string[] = [];
  if (rules > 0) consequences.push(`drop ${rules === 1 ? 'that rule' : 'those rules'}`);
  if (days > 0) consequences.push('leave those patients counted against no ratio');
  return `"${name}" is cited by ${cited.join(' and ')}. Rename it instead; deleting it would ${consequences.join(' and ')}.`;
}

export function deleteAcuityTier(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(acuityTierTable).where(eq(acuityTierTable.id, id)).get();
  if (!row) throw new Error(`Acuity tier ${id} not found`);
  // Deactivated rules count: past periods were judged by them.
  const rules =
    db
      .select({ n: sql<number>`count(*)` })
      .from(ratioRuleTable)
      .where(eq(ratioRuleTable.acuityTierId, id))
      .get()?.n ?? 0;
  // A zero entry cites nothing a demand calculation would use, so only counts above 0 block.
  const days =
    db
      .select({ n: sql<number>`count(*)` })
      .from(censusForecastTable)
      .where(
        and(
          eq(censusForecastTable.unitId, row.unitId),
          sql`(exists (select 1 from json_each(${censusForecastTable.acuityMix}) where key = ${id} and value > 0)
            or (${censusForecastTable.actualAcuityMix} is not null and exists (select 1 from json_each(${censusForecastTable.actualAcuityMix}) where key = ${id} and value > 0)))`,
        ),
      )
      .get()?.n ?? 0;
  if (rules > 0 || days > 0) throw new Error(citedMessage(row.name, rules, days));
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
    minRnShare: input.minRnShare ?? null,
    active: input.active,
  };
  validateRatioRule(input.role, input.minRnShare);
  db.insert(ratioRuleTable).values(row).run();
  const after = toRatioRule(row as typeof ratioRuleTable.$inferSelect);
  recordAudit(db, { entityType: 'ratio_rule', entityId: id, action: 'create', actor, after });
  return after;
}

export interface RatioRulePatch {
  role?: RatioRole;
  acuityTierId?: Id | null;
  maxPatientsPerNurse?: number;
  citation?: string | null;
  /** null clears it. */
  minRnShare?: number | null;
  active?: boolean;
}

const RATIO_RULE_PATCH_KEYS: PatchKeys<RatioRulePatch> = {
  role: true,
  acuityTierId: true,
  maxPatientsPerNurse: true,
  citation: true,
  minRnShare: true,
  active: true,
};

/** An RN share belongs to a licensed rule only, and is a fraction of the licensed nurses. */
function validateRatioRule(role: RatioRole, minRnShare: number | null | undefined): void {
  if (minRnShare === null || minRnShare === undefined) return;
  if (role !== 'licensed') {
    throw new Error('Only a licensed-nurse ratio can require a share of RNs');
  }
  if (!(minRnShare > 0 && minRnShare <= 1)) {
    throw new Error('The share of RNs must be more than 0% and at most 100%');
  }
}

export function updateRatioRule(
  db: DbLike,
  id: Id,
  patch: RatioRulePatch,
  actor: string,
): RatioRule {
  return auditedUpdate<RatioRule, RatioRulePatch>(db, {
    id,
    entityType: 'ratio_rule',
    entityLabel: 'ratio rule',
    allowed: RATIO_RULE_PATCH_KEYS,
    patch,
    read: (rowId) => {
      const row = db.select().from(ratioRuleTable).where(eq(ratioRuleTable.id, rowId)).get();
      return row ? toRatioRule(row) : undefined;
    },
    write: (rowId, values) =>
      db.update(ratioRuleTable).set(values).where(eq(ratioRuleTable.id, rowId)).run(),
    notFound: `Ratio rule ${id} not found`,
    validate: (values, before) =>
      validateRatioRule(
        values.role ?? before.role,
        values.minRnShare === undefined ? before.minRnShare : values.minRnShare,
      ),
    actor,
  });
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
