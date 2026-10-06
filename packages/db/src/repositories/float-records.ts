/**
 * Float records: each nurse sent off the unit to work another, and any objection she raised.
 *
 * The float rotation in core's `floatOrder` is only fair if it can see who was floated before,
 * so every float is a row of its own — one that outlives the home shift it removed, which is why
 * it carries the shift's identity rather than a foreign key. An objection (not competent on the
 * receiving unit, say) is kept on the record and never stops the float; it is what the nurse's
 * representative asks for afterwards, so recording one is audited with the record as it stood.
 */

import type { FloatRecord, Id, IsoDate } from '@shiftnurse/core';
import { and, asc, eq, gte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { floatRecord as table } from '../schema.js';

const ENTITY = 'float_record';

function toFloatRecord(r: typeof table.$inferSelect): FloatRecord {
  return {
    id: r.id,
    unitId: r.unitId,
    nurseId: r.nurseId,
    date: r.date,
    shiftTypeId: r.shiftTypeId,
    toUnit: r.toUnit,
    volunteered: r.volunteered,
    ...(r.objection === null ? {} : { objection: r.objection }),
    actor: r.actor,
    at: r.at,
  };
}

/** The unit's floats on or after `since`, oldest first. */
export function listFloatRecords(db: DbLike, unitId: Id, since: IsoDate): FloatRecord[] {
  return db
    .select()
    .from(table)
    .where(and(eq(table.unitId, unitId), gte(table.date, since)))
    .orderBy(asc(table.date), asc(table.at), asc(table.id))
    .all()
    .map(toFloatRecord);
}

export function getFloatRecord(db: DbLike, id: Id): FloatRecord | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toFloatRecord(row) : undefined;
}

export function createFloatRecord(
  db: DbLike,
  input: Omit<FloatRecord, 'id' | 'actor' | 'at'>,
  actor: string,
): FloatRecord {
  const toUnit = input.toUnit.trim();
  if (!toUnit) throw new Error('Name the unit the nurse is floated to');
  const objection = input.objection?.trim();
  const record: FloatRecord = {
    id: ids.floatRecord(),
    unitId: input.unitId,
    nurseId: input.nurseId,
    date: input.date,
    shiftTypeId: input.shiftTypeId,
    toUnit,
    volunteered: input.volunteered,
    ...(objection ? { objection } : {}),
    actor,
    at: Date.now(),
  };
  db.insert(table)
    .values({ ...record, objection: record.objection ?? null })
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

/** Records (or replaces) the nurse's objection; a blank one is refused, since it records nothing. */
export function recordFloatObjection(
  db: DbLike,
  id: Id,
  objection: string,
  actor: string,
): FloatRecord {
  const text = objection.trim();
  if (!text) throw new Error('State the nurse’s objection to record one');
  const before = getFloatRecord(db, id);
  if (!before) throw new Error(`Float record ${id} not found`);
  db.update(table).set({ objection: text }).where(eq(table.id, id)).run();
  const after: FloatRecord = { ...before, objection: text };
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'update', actor, before, after });
  return after;
}
