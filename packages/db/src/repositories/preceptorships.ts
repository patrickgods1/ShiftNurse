/**
 * Preceptorships: which nurse is oriented by which, and for what dates.
 *
 * `orientee-with-preceptor` keeps an orientee only on shifts a preceptor works, so a record that
 * pairs a nurse with themselves, names someone from another unit, or runs backwards would look
 * like orientation and constrain nothing (or, for a self-pairing, everything vacuously). All are
 * refused in words, and every change is audited with its `before`.
 */

import type { Id, IsoDate, Preceptorship } from '@shiftnurse/core';
import { compareDates } from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { nurse as nurseTable, preceptorship as table } from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

const ENTITY = 'preceptorship';

export type PreceptorshipInput = Omit<Preceptorship, 'id'>;

/** The unit and the pair never change: to re-pair, delete the record and add another. */
export interface PreceptorshipPatch {
  startDate?: IsoDate;
  endDate?: IsoDate;
}

const PATCH_KEYS: PatchKeys<PreceptorshipPatch> = { startDate: true, endDate: true };

function toPreceptorship(r: typeof table.$inferSelect): Preceptorship {
  return {
    id: r.id,
    unitId: r.unitId,
    orienteeId: r.orienteeId,
    preceptorId: r.preceptorId,
    startDate: r.startDate,
    endDate: r.endDate,
  };
}

export function listPreceptorships(db: DbLike, unitId: Id): Preceptorship[] {
  return db
    .select()
    .from(table)
    .where(eq(table.unitId, unitId))
    .orderBy(asc(table.startDate), asc(table.id))
    .all()
    .map(toPreceptorship);
}

/** Records touching `[start, end]`, whole: one straddling the window keeps its full range. */
export function listPreceptorshipsOverlapping(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): Preceptorship[] {
  return db
    .select()
    .from(table)
    .where(and(eq(table.unitId, unitId), lte(table.startDate, end), gte(table.endDate, start)))
    .orderBy(asc(table.startDate), asc(table.id))
    .all()
    .map(toPreceptorship);
}

export function getPreceptorship(db: DbLike, id: Id): Preceptorship | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toPreceptorship(row) : undefined;
}

export function createPreceptorship(
  db: DbLike,
  input: PreceptorshipInput,
  actor: string,
): Preceptorship {
  const record: Preceptorship = {
    id: ids.preceptorship(),
    unitId: input.unitId,
    orienteeId: input.orienteeId,
    preceptorId: input.preceptorId,
    startDate: input.startDate,
    endDate: input.endDate,
  };
  validate(db, record);
  db.insert(table)
    .values({ ...record, createdAt: Date.now() })
    .run();
  recordAudit(db, {
    entityType: ENTITY,
    entityId: record.id,
    action: 'create',
    actor,
    after: record,
  });
  return record;
}

export function updatePreceptorship(
  db: DbLike,
  id: Id,
  patch: PreceptorshipPatch,
  actor: string,
): Preceptorship {
  const before = getPreceptorship(db, id);
  if (!before) throw new Error(`Preceptorship ${id} not found`);
  const changes = patchOf(patch, PATCH_KEYS, 'preceptorship');
  const after: Preceptorship = { ...before };
  if (changes.startDate !== undefined) after.startDate = changes.startDate;
  if (changes.endDate !== undefined) after.endDate = changes.endDate;
  validate(db, after);
  db.update(table)
    .set({ startDate: after.startDate, endDate: after.endDate })
    .where(eq(table.id, id))
    .run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'update', actor, before, after });
  return after;
}

export function deletePreceptorship(db: DbLike, id: Id, actor: string): void {
  const before = getPreceptorship(db, id);
  if (!before) throw new Error(`Preceptorship ${id} not found`);
  db.delete(table).where(eq(table.id, id)).run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'delete', actor, before });
}

function validate(db: DbLike, record: Preceptorship): void {
  if (record.orienteeId === record.preceptorId) {
    throw new Error('A nurse cannot be their own preceptor');
  }
  if (compareDates(record.endDate, record.startDate) < 0) {
    throw new Error('The orientation ends before it starts');
  }
  for (const nurseId of [record.orienteeId, record.preceptorId]) {
    const row = db
      .select({ unitId: nurseTable.unitId })
      .from(nurseTable)
      .where(eq(nurseTable.id, nurseId))
      .get();
    if (!row || row.unitId !== record.unitId) throw new Error('That nurse is not on this unit');
  }
}
