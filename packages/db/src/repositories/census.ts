/**
 * Census forecasts: one row per date × shift type, keyed by that pair.
 *
 * Upsert rather than create/update because the manager thinks in cells of a grid, not in
 * records — "Tuesday nights, 24 patients" is the same statement whether or not a row
 * already exists. Validation runs here, not only in the UI, so a proposal accepted in bulk
 * cannot slip in a mix that does not add up.
 */

import { type CensusForecast, type Id, type IsoDate, validateAcuityMix } from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toCensusForecast } from '../mappers.js';
import { censusForecast as table } from '../schema.js';

export function listCensusForecastsInRange(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): CensusForecast[] {
  return db
    .select()
    .from(table)
    .where(and(eq(table.unitId, unitId), gte(table.date, start), lte(table.date, end)))
    .orderBy(asc(table.date))
    .all()
    .map(toCensusForecast);
}

/** Everything the unit has ever recorded — the forecaster's and back-test's raw material. */
export function listCensusHistory(db: DbLike, unitId: Id): CensusForecast[] {
  return db
    .select()
    .from(table)
    .where(eq(table.unitId, unitId))
    .orderBy(asc(table.date))
    .all()
    .map(toCensusForecast);
}

export interface CensusForecastInput {
  unitId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  projectedCensus: number;
  acuityMix: Record<Id, number>;
  source: CensusForecast['source'];
}

export function upsertCensusForecast(
  db: DbLike,
  input: CensusForecastInput,
  actor: string,
): CensusForecast {
  const problems = validateAcuityMix(input.projectedCensus, input.acuityMix);
  if (problems.length > 0) {
    throw new Error(`Invalid census for ${input.date}: ${problems.join('; ')}`);
  }
  const existing = db
    .select()
    .from(table)
    .where(and(eq(table.date, input.date), eq(table.shiftTypeId, input.shiftTypeId)))
    .get();

  if (existing) {
    const before = toCensusForecast(existing);
    const merged = {
      ...existing,
      projectedCensus: input.projectedCensus,
      acuityMix: input.acuityMix,
      source: input.source,
    };
    db.update(table).set(merged).where(eq(table.id, existing.id)).run();
    const after = toCensusForecast(merged);
    recordAudit(db, {
      entityType: 'census_forecast',
      entityId: existing.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }

  const id = ids.census();
  const row: typeof table.$inferInsert = { id, ...input };
  db.insert(table).values(row).run();
  const after = toCensusForecast(row as typeof table.$inferSelect);
  recordAudit(db, { entityType: 'census_forecast', entityId: id, action: 'create', actor, after });
  return after;
}

/** Accepting a batch of proposals is one decision; it is audited as one and applied as one. */
export function upsertCensusForecasts(
  db: DbLike,
  inputs: readonly CensusForecastInput[],
  actor: string,
): CensusForecast[] {
  return inputs.map((input) => upsertCensusForecast(db, input, actor));
}

/** Record what actually happened, after the shift. */
export function recordActualCensus(
  db: DbLike,
  id: Id,
  actualCensus: number,
  actualAcuityMix: Record<Id, number>,
  actor: string,
): CensusForecast {
  const problems = validateAcuityMix(actualCensus, actualAcuityMix);
  if (problems.length > 0) throw new Error(`Invalid actual census: ${problems.join('; ')}`);
  const row = db.select().from(table).where(eq(table.id, id)).get();
  if (!row) throw new Error(`Census forecast ${id} not found`);
  const before = toCensusForecast(row);
  const merged = { ...row, actualCensus, actualAcuityMix };
  db.update(table).set(merged).where(eq(table.id, id)).run();
  const after = toCensusForecast(merged);
  recordAudit(db, {
    entityType: 'census_forecast',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

export function deleteCensusForecast(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  if (!row) return;
  db.delete(table).where(eq(table.id, id)).run();
  recordAudit(db, {
    entityType: 'census_forecast',
    entityId: id,
    action: 'delete',
    actor,
    before: toCensusForecast(row),
  });
}
