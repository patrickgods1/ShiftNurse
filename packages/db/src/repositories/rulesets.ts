/**
 * Rule sets: the versioned contract configuration every period is judged under. Saving always
 * inserts a new version — a published period snapshots the version it was solved under, so an
 * edit must never rewrite the rules an existing schedule was judged by.
 */

import type { FairnessWeights, Id, RuleConfig, RuleSet, WeekendDefinition } from '@shiftnurse/core';
import { desc, eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { ruleConfig as ruleConfigTable, ruleSet as ruleSetTable } from '../schema.js';

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
    fairnessWeights: row.fairnessWeights as FairnessWeights,
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
  draft: Pick<RuleSet, 'unitId' | 'name' | 'configs' | 'weekendDefinition' | 'fairnessWeights'>,
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
    fairnessWeights: draft.fairnessWeights,
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
    fairnessWeights: draft.fairnessWeights,
    createdAt,
  };
  recordAudit(db, { entityType: 'rule_set', entityId: id, action: 'create', actor, after });
  return after;
}
