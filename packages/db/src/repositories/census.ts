/**
 * Census forecasts: one row per date × shift type, keyed by that pair.
 *
 * Upsert rather than create/update because the manager thinks in cells of a grid, not in
 * records — "Tuesday nights, 24 patients" is the same statement whether or not a row
 * already exists. Validation runs here, not only in the UI, so a proposal accepted in bulk
 * cannot slip in a mix that does not add up. The mix is judged against the unit's own tiers,
 * so messages name tiers rather than ids and a unit with no tiers saves a census with no mix.
 * The mix may name only this unit's tiers (core's `validateAcuityMix` refuses a stranger), and the
 * shift type must be the unit's.
 */

import { type CensusForecast, type Id, type IsoDate, validateAcuityMix } from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toCensusForecast } from '../mappers.js';
import { shiftType, censusForecast as table, unit as unitTable } from '../schema.js';
import { listAcuityTiersForUnit } from './acuity.js';

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

function unitName(db: DbLike, unitId: Id): string {
  return (
    db.select({ name: unitTable.name }).from(unitTable).where(eq(unitTable.id, unitId)).get()
      ?.name ?? 'that unit'
  );
}

/** Refuse a shift type that is missing or belongs to another unit, before anything is written. */
function requireShiftOnUnit(db: DbLike, shiftTypeId: Id, unitId: Id): void {
  const shift = db
    .select({ name: shiftType.name, unitId: shiftType.unitId })
    .from(shiftType)
    .where(eq(shiftType.id, shiftTypeId))
    .get();
  if (!shift) throw new Error('That shift type was not found. Reload the page.');
  if (shift.unitId !== unitId) {
    throw new Error(
      `${shift.name} is a shift on ${unitName(db, shift.unitId)}, not on ${unitName(db, unitId)}.`,
    );
  }
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
  const problems = validateAcuityMix(
    input.projectedCensus,
    input.acuityMix,
    listAcuityTiersForUnit(db, input.unitId),
  );
  if (problems.length > 0) {
    throw new Error(`Invalid census for ${input.date}: ${problems.join('; ')}`);
  }
  requireShiftOnUnit(db, input.shiftTypeId, input.unitId);
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

/**
 * Accepting a batch of proposals is one decision: it runs in one transaction, with one audit row
 * per day changed.
 */
export function upsertCensusForecasts(
  // A transaction, not any handle: these writes are only correct all-or-nothing.
  db: ShiftNurseTx,
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
  // The row first: its unit's tiers are what the mix is judged against.
  const row = db.select().from(table).where(eq(table.id, id)).get();
  if (!row) throw new Error('That census day was not found. Reload the page.');
  const problems = validateAcuityMix(
    actualCensus,
    actualAcuityMix,
    listAcuityTiersForUnit(db, row.unitId),
  );
  if (problems.length > 0) throw new Error(`Invalid actual census: ${problems.join('; ')}`);
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
  if (!row) throw new Error('That census day was not found. Reload the page.');
  db.delete(table).where(eq(table.id, id)).run();
  recordAudit(db, {
    entityType: 'census_forecast',
    entityId: id,
    action: 'delete',
    actor,
    before: toCensusForecast(row),
  });
}
