/**
 * Incompatible-staff groups: nurses the manager keeps off the floor together.
 *
 * A group is a row plus its members, and the two are only correct together — a group whose
 * member rows failed to write would protect nobody while the roster screen said it did — so
 * every write takes `ShiftNurseTx`. Every write is also audited with a stated reason
 * (`recordAuditStrict`): keeping two people apart is a management decision that may be
 * challenged, and the reason is what gets quoted. The reason is HR-sensitive and is never copied
 * into a violation message; see `IncompatibilityGroup`.
 */

import type { Id, IncompatibilityGroup, IsoDate } from '@shiftnurse/core';
import { compareDates } from '@shiftnurse/core';
import { asc, eq, inArray } from 'drizzle-orm';
import { recordAuditStrict } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import {
  incompatibilityGroup as groupTable,
  incompatibilityMember as memberTable,
  nurse as nurseTable,
} from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

const ENTITY = 'incompatibility_group';

/** What a manager enters; the reason is passed separately, as it is for every audited decision. */
export type IncompatibilityGroupInput = Omit<IncompatibilityGroup, 'id' | 'reason'>;

/** Optional dates take `null` to clear them; an omitted key is left alone. */
export interface IncompatibilityGroupPatch {
  name?: string;
  nurseIds?: Id[];
  maxTogether?: number;
  startsOn?: IsoDate | null;
  endsOn?: IsoDate | null;
}

const PATCH_KEYS: PatchKeys<IncompatibilityGroupPatch> = {
  name: true,
  nurseIds: true,
  maxTogether: true,
  startsOn: true,
  endsOn: true,
};

export function listIncompatibilityGroups(db: DbLike, unitId: Id): IncompatibilityGroup[] {
  const rows = db
    .select()
    .from(groupTable)
    .where(eq(groupTable.unitId, unitId))
    .orderBy(asc(groupTable.name), asc(groupTable.id))
    .all();
  if (rows.length === 0) return [];
  const members = db
    .select()
    .from(memberTable)
    .where(
      inArray(
        memberTable.groupId,
        rows.map((r) => r.id),
      ),
    )
    .all();
  return rows.map((row) =>
    toGroup(
      row,
      members.filter((m) => m.groupId === row.id).map((m) => m.nurseId),
    ),
  );
}

export function getIncompatibilityGroup(db: DbLike, id: Id): IncompatibilityGroup | undefined {
  const row = db.select().from(groupTable).where(eq(groupTable.id, id)).get();
  if (!row) return undefined;
  return toGroup(row, memberIds(db, id));
}

export function createIncompatibilityGroup(
  tx: ShiftNurseTx,
  input: IncompatibilityGroupInput,
  reason: string,
  actor: string,
): IncompatibilityGroup {
  const group: IncompatibilityGroup = {
    ...input,
    id: ids.incompatibilityGroup(),
    name: input.name.trim(),
    nurseIds: [...input.nurseIds].sort(),
    reason: reason.trim(),
  };
  validate(tx, group);
  // Audited first: a missing reason must refuse the change before anything is written.
  recordAuditStrict(
    tx,
    { entityType: ENTITY, entityId: group.id, action: 'create', actor, after: group, reason },
    { requireReason: true },
  );
  tx.insert(groupTable).values(toRow(group)).run();
  writeMembers(tx, group);
  return group;
}

export function updateIncompatibilityGroup(
  tx: ShiftNurseTx,
  id: Id,
  patch: IncompatibilityGroupPatch,
  reason: string,
  actor: string,
): IncompatibilityGroup {
  const before = getIncompatibilityGroup(tx, id);
  if (!before) throw new Error(`Incompatibility group ${id} not found`);
  const changes = patchOf(patch, PATCH_KEYS, 'incompatibility group');
  const after: IncompatibilityGroup = { ...before, reason: reason.trim() };
  if (changes.name !== undefined) after.name = changes.name.trim();
  if (changes.nurseIds !== undefined) after.nurseIds = [...changes.nurseIds].sort();
  if (changes.maxTogether !== undefined) after.maxTogether = changes.maxTogether;
  for (const key of ['startsOn', 'endsOn'] as const) {
    const value = changes[key];
    if (value === null) delete after[key];
    else if (value !== undefined) after[key] = value;
  }
  validate(tx, after);
  recordAuditStrict(
    tx,
    { entityType: ENTITY, entityId: id, action: 'update', actor, before, after, reason },
    { requireReason: true },
  );
  tx.update(groupTable).set(toRow(after)).where(eq(groupTable.id, id)).run();
  tx.delete(memberTable).where(eq(memberTable.groupId, id)).run();
  writeMembers(tx, after);
  return after;
}

export function deleteIncompatibilityGroup(
  tx: ShiftNurseTx,
  id: Id,
  reason: string,
  actor: string,
): void {
  const before = getIncompatibilityGroup(tx, id);
  if (!before) throw new Error(`Incompatibility group ${id} not found`);
  recordAuditStrict(
    tx,
    { entityType: ENTITY, entityId: id, action: 'delete', actor, before, reason },
    { requireReason: true },
  );
  // Members go with it (ON DELETE CASCADE).
  tx.delete(groupTable).where(eq(groupTable.id, id)).run();
}

/** A group that would protect nobody, or reach into another unit, is refused by name. */
function validate(db: DbLike, group: IncompatibilityGroup): void {
  if (!group.name) throw new Error('An incompatibility group needs a name');
  const distinct = new Set(group.nurseIds);
  if (distinct.size < 2 || distinct.size !== group.nurseIds.length) {
    throw new Error('An incompatibility group needs at least two different nurses');
  }
  if (!Number.isInteger(group.maxTogether) || group.maxTogether < 1) {
    throw new Error('At least 1 member of a group must be allowed on the floor at a time');
  }
  if (group.maxTogether >= distinct.size) {
    throw new Error(
      `A group of ${distinct.size} can allow at most ${distinct.size - 1} on the floor at once; ` +
        'allowing all of them keeps nobody apart',
    );
  }
  const found = db
    .select({ id: nurseTable.id, unitId: nurseTable.unitId })
    .from(nurseTable)
    .where(inArray(nurseTable.id, [...distinct]))
    .all();
  for (const nurseId of distinct) {
    const row = found.find((f) => f.id === nurseId);
    if (!row || row.unitId !== group.unitId) {
      throw new Error(`Nurse ${nurseId} is not on this unit`);
    }
  }
  if (group.startsOn && group.endsOn && compareDates(group.endsOn, group.startsOn) < 0) {
    throw new Error('The group ends before it starts');
  }
}

function memberIds(db: DbLike, groupId: Id): Id[] {
  return db
    .select()
    .from(memberTable)
    .where(eq(memberTable.groupId, groupId))
    .all()
    .map((m) => m.nurseId);
}

function writeMembers(tx: ShiftNurseTx, group: IncompatibilityGroup): void {
  tx.insert(memberTable)
    .values(group.nurseIds.map((nurseId) => ({ groupId: group.id, nurseId })))
    .run();
}

function toRow(group: IncompatibilityGroup): typeof groupTable.$inferInsert {
  return {
    id: group.id,
    unitId: group.unitId,
    name: group.name,
    maxTogether: group.maxTogether,
    reason: group.reason,
    startsOn: group.startsOn ?? null,
    endsOn: group.endsOn ?? null,
  };
}

function toGroup(row: typeof groupTable.$inferSelect, nurseIds: Id[]): IncompatibilityGroup {
  return {
    id: row.id,
    unitId: row.unitId,
    name: row.name,
    // Sorted, as written: the member table has no order of its own.
    nurseIds: [...nurseIds].sort(),
    maxTogether: row.maxTogether,
    reason: row.reason,
    ...(row.startsOn ? { startsOn: row.startsOn } : {}),
    ...(row.endsOn ? { endsOn: row.endsOn } : {}),
  };
}
