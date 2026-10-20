/**
 * Rest waivers: a nurse's written waiver of the minimum rest before the one shift that starts on
 * a date (VA–NNU 2023 Art. 13 §2).
 *
 * Without a record, the only way to let a short turnaround stand is to relax the rest rule for
 * everyone. The waiver is per nurse and per shift, and its reason is what gets read out if the
 * turnaround is grieved, so both writes go through `recordAuditStrict`. The reason is checked first,
 * then the row is written, then the audit: a write that fails must not leave an append-only entry
 * for a change that never happened.
 */

import type { Id, IsoDate, RestWaiver } from '@shiftnurse/core';
import { and, asc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import { recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { restWaiver as table } from '../schema.js';
import { requireWorksOnUnit } from './nurse-units.js';

const ENTITY = 'rest_waiver';

export interface RestWaiverInput {
  unitId: Id;
  nurseId: Id;
  date: IsoDate;
  reason: string;
}

function toRestWaiver(r: typeof table.$inferSelect): RestWaiver {
  return {
    id: r.id,
    unitId: r.unitId,
    nurseId: r.nurseId,
    date: r.date,
    reason: r.reason,
    createdAt: r.createdAt,
  };
}

export function listRestWaivers(db: DbLike, unitId: Id): RestWaiver[] {
  return db
    .select()
    .from(table)
    .where(eq(table.unitId, unitId))
    .orderBy(asc(table.date), asc(table.nurseId))
    .all()
    .map(toRestWaiver);
}

/**
 * Waivers dated within `[startDate, endDate]`. No lookback: a waiver excuses the shift that
 * starts on its date, and only a shift inside the period is ever flagged.
 */
export function restWaiversForPeriod(
  db: DbLike,
  unitId: Id,
  startDate: IsoDate,
  endDate: IsoDate,
): RestWaiver[] {
  return db
    .select()
    .from(table)
    .where(and(eq(table.unitId, unitId), gte(table.date, startDate), lte(table.date, endDate)))
    .orderBy(asc(table.date), asc(table.nurseId))
    .all()
    .map(toRestWaiver);
}

/**
 * These nurses' waivers recorded on other units, dated within `[startDate, endDate]`, for
 * `perNurseRecordsFor`. This unit's own rows are left out so none is listed twice.
 */
export function restWaiversElsewhere(
  db: DbLike,
  unitId: Id,
  nurseIds: readonly Id[],
  startDate: IsoDate,
  endDate: IsoDate,
): RestWaiver[] {
  if (nurseIds.length === 0) return [];
  return db
    .select()
    .from(table)
    .where(
      and(
        ne(table.unitId, unitId),
        inArray(table.nurseId, [...nurseIds]),
        gte(table.date, startDate),
        lte(table.date, endDate),
      ),
    )
    .orderBy(asc(table.date), asc(table.nurseId))
    .all()
    .map(toRestWaiver);
}

export function getRestWaiver(db: DbLike, id: Id): RestWaiver | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toRestWaiver(row) : undefined;
}

export function createRestWaiver(db: DbLike, input: RestWaiverInput, actor: string): RestWaiver {
  const reason = requireReason(input.reason, 'record a rest waiver');
  requireWorksOnUnit(db, input.nurseId, input.unitId, { start: input.date, end: input.date });
  const existing = db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.nurseId, input.nurseId), eq(table.date, input.date)))
    .get();
  if (existing) throw new Error(`That nurse already has a rest waiver on ${input.date}`);

  const record: RestWaiver = {
    id: ids.restWaiver(),
    unitId: input.unitId,
    nurseId: input.nurseId,
    date: input.date,
    reason,
    createdAt: Date.now(),
  };
  db.insert(table).values(record).run();
  recordAuditStrict(
    db,
    { entityType: ENTITY, entityId: record.id, action: 'create', actor, after: record, reason },
    { requireReason: true },
  );
  return record;
}

/** Removing a waiver puts the shift back under the rest rule, so it too is quoted with a reason. */
export function deleteRestWaiver(db: DbLike, id: Id, reason: string, actor: string): void {
  const stated = requireReason(reason, 'remove a rest waiver');
  const before = getRestWaiver(db, id);
  if (!before) throw new Error(`Rest waiver ${id} not found`);
  db.delete(table).where(eq(table.id, id)).run();
  recordAuditStrict(
    db,
    { entityType: ENTITY, entityId: id, action: 'delete', actor, before, reason: stated },
    { requireReason: true },
  );
}

function requireReason(reason: string, doing: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error(`Give a reason to ${doing}; it is what is quoted if it is grieved`);
  return trimmed;
}
