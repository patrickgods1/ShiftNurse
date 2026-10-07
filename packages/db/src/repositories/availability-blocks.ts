/**
 * Accommodations: recurring windows a nurse cannot work (`AvailabilityBlock`) — a religious,
 * disability, pregnancy or lactation accommodation.
 *
 * Generate treats a block as absolute, so creating or loosening one is a decision that may be
 * questioned, and its reason names a faith, a disability or a pregnancy. Every write is audited
 * with that reason (`recordAuditStrict`, always required) and a blank one refuses the change before
 * anything is written. Like an incompatibility group's, the reason is shown on the roster only: it
 * is never copied into a violation message, and `RECORD_EXCLUDED_ENTITIES` keeps the audit entries
 * out of a nurse's exported record.
 */

import { type AvailabilityBlock, type Id, type IsoDate, parseTimeOfDay } from '@shiftnurse/core';
import { asc, eq } from 'drizzle-orm';
import { recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { nurse as nurseTable, availabilityBlock as table } from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

const ENTITY = 'availability_block';

/** What a manager enters; `reason` is the stated reason, kept on the block and in the audit. */
export type AvailabilityBlockInput = Omit<AvailabilityBlock, 'id'>;

/** Optional dates take `null` to clear them; an omitted key is left alone. `reason` is required. */
export interface AvailabilityBlockPatch {
  weekdays?: AvailabilityBlock['weekdays'];
  startTime?: string;
  endTime?: string;
  startsOn?: IsoDate | null;
  endsOn?: IsoDate | null;
  reason?: string;
}

const PATCH_KEYS: PatchKeys<AvailabilityBlockPatch> = {
  weekdays: true,
  startTime: true,
  endTime: true,
  startsOn: true,
  endsOn: true,
  reason: true,
};

function toBlock(r: typeof table.$inferSelect): AvailabilityBlock {
  return {
    id: r.id,
    unitId: r.unitId,
    nurseId: r.nurseId,
    weekdays: [...r.weekdays].sort((a, b) => a - b),
    startTime: r.startTime,
    endTime: r.endTime,
    ...(r.startsOn ? { startsOn: r.startsOn } : {}),
    ...(r.endsOn ? { endsOn: r.endsOn } : {}),
    reason: r.reason,
  };
}

function toRow(b: AvailabilityBlock): typeof table.$inferInsert {
  return {
    id: b.id,
    unitId: b.unitId,
    nurseId: b.nurseId,
    weekdays: b.weekdays,
    startTime: b.startTime,
    endTime: b.endTime,
    startsOn: b.startsOn ?? null,
    endsOn: b.endsOn ?? null,
    reason: b.reason,
  };
}

export function listAvailabilityBlocks(db: DbLike, unitId: Id): AvailabilityBlock[] {
  return db
    .select()
    .from(table)
    .where(eq(table.unitId, unitId))
    .orderBy(asc(table.nurseId), asc(table.startTime), asc(table.id))
    .all()
    .map(toBlock);
}

export function getAvailabilityBlock(db: DbLike, id: Id): AvailabilityBlock | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toBlock(row) : undefined;
}

export function createAvailabilityBlock(
  db: DbLike,
  input: AvailabilityBlockInput,
  actor: string,
): AvailabilityBlock {
  const block: AvailabilityBlock = {
    id: ids.availabilityBlock(),
    unitId: input.unitId,
    nurseId: input.nurseId,
    weekdays: [...input.weekdays].sort((a, b) => a - b),
    startTime: input.startTime,
    endTime: input.endTime,
    ...(input.startsOn ? { startsOn: input.startsOn } : {}),
    ...(input.endsOn ? { endsOn: input.endsOn } : {}),
    reason: requireReason(input.reason, 'record an accommodation'),
  };
  validate(db, block);
  // Audited first: a missing reason must refuse the change before anything is written.
  recordAuditStrict(
    db,
    {
      entityType: ENTITY,
      entityId: block.id,
      action: 'create',
      actor,
      after: block,
      reason: block.reason,
    },
    { requireReason: true },
  );
  db.insert(table).values(toRow(block)).run();
  return block;
}

/** `patch.reason` is required: it is the stated reason for this change and replaces the stored one. */
export function updateAvailabilityBlock(
  db: DbLike,
  id: Id,
  patch: AvailabilityBlockPatch,
  actor: string,
): AvailabilityBlock {
  const before = getAvailabilityBlock(db, id);
  if (!before) throw new Error(`Accommodation ${id} not found`);
  const changes = patchOf(patch, PATCH_KEYS, 'accommodation');
  const reason = requireReason(changes.reason ?? '', 'change an accommodation');
  const after: AvailabilityBlock = { ...before, reason };
  if (changes.weekdays !== undefined) after.weekdays = [...changes.weekdays].sort((a, b) => a - b);
  if (changes.startTime !== undefined) after.startTime = changes.startTime;
  if (changes.endTime !== undefined) after.endTime = changes.endTime;
  for (const key of ['startsOn', 'endsOn'] as const) {
    const value = changes[key];
    if (value === null) delete after[key];
    else if (value !== undefined) after[key] = value;
  }
  validate(db, after);
  recordAuditStrict(
    db,
    { entityType: ENTITY, entityId: id, action: 'update', actor, before, after, reason },
    { requireReason: true },
  );
  db.update(table).set(toRow(after)).where(eq(table.id, id)).run();
  return after;
}

/** Removing a block frees the nurse to be scheduled in the window, so it too needs a reason. */
export function deleteAvailabilityBlock(db: DbLike, id: Id, reason: string, actor: string): void {
  const stated = requireReason(reason, 'remove an accommodation');
  const before = getAvailabilityBlock(db, id);
  if (!before) throw new Error(`Accommodation ${id} not found`);
  recordAuditStrict(
    db,
    { entityType: ENTITY, entityId: id, action: 'delete', actor, before, reason: stated },
    { requireReason: true },
  );
  db.delete(table).where(eq(table.id, id)).run();
}

/** A window that bars nothing, or reaches into another unit, is refused by name. */
function validate(db: DbLike, block: AvailabilityBlock): void {
  if (block.weekdays.length === 0) throw new Error('Choose at least one day of the week');
  const distinct = new Set(block.weekdays);
  if (distinct.size !== block.weekdays.length) throw new Error('Each day may be listed only once');
  for (const day of block.weekdays) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`${day} is not a day of the week`);
    }
  }
  // parseTimeOfDay throws a RangeError naming the bad value.
  parseTimeOfDay(block.startTime);
  parseTimeOfDay(block.endTime);
  if (block.startsOn && block.endsOn && block.endsOn < block.startsOn) {
    throw new Error('The accommodation ends before it starts');
  }
  const owner = db
    .select({ unitId: nurseTable.unitId })
    .from(nurseTable)
    .where(eq(nurseTable.id, block.nurseId))
    .get();
  if (!owner || owner.unitId !== block.unitId) throw new Error('That nurse is not on this unit');
}

function requireReason(reason: string, doing: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error(`Give a reason to ${doing}; it is kept for HR and the audit trail`);
  return trimmed;
}
