/**
 * Preceptorships: which nurse is oriented by which, and for what dates.
 *
 * `orientee-with-preceptor` keeps an orientee only on shifts a preceptor works, so a record that
 * pairs a nurse with themselves, names someone from another unit, or runs backwards would look
 * like orientation and constrain nothing (or, for a self-pairing, everything vacuously). So would
 * a preceptor who could not supervise the orientee — a nursing assistant "keeping" a new RN — so
 * a new record must pass `mayPrecept`. All are refused in words, and every change is audited with
 * its `before`.
 */

import type { Id, IsoDate, NurseRole, Preceptorship } from '@shiftnurse/core';
import { compareDates, mayPrecept } from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { preceptorship as table } from '../schema.js';
import { requireWorksOnUnit } from './nurse-units.js';
import { type PatchKeys, patchOf } from './patch.js';
import { getNurse } from './roster.js';

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
  requireMayPrecept(db, record);
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
    requireWorksOnUnit(db, nurseId, record.unitId, {
      start: record.startDate,
      end: record.endDate,
    });
  }
}

const NEEDS: Record<NurseRole, string> = {
  RN: 'an RN in orientation needs an experienced RN',
  LPN: 'an LPN in orientation needs an experienced RN or LPN',
  CNA: 'a CNA in orientation needs an experienced RN or CNA',
};

/**
 * Checked on create only: an update can move only the dates, and refusing it would strand an
 * orientation recorded before this rule, which the manager can still end or delete.
 */
function requireMayPrecept(db: DbLike, record: Preceptorship): void {
  // validate's membership check has already proven both nurses exist.
  const preceptor = getNurse(db, record.preceptorId)!;
  const orientee = getNurse(db, record.orienteeId)!;
  if (mayPrecept(preceptor, orientee)) return;
  throw new Error(
    `${preceptor.firstName} ${preceptor.lastName} cannot precept ` +
      `${orientee.firstName} ${orientee.lastName}: ${NEEDS[orientee.role]}.`,
  );
}
