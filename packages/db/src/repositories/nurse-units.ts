/**
 * The float pool: nurses who also work on a unit other than their home unit.
 *
 * Every unit-scoped read in the app means "the nurses whose `unitId` is this unit", so a nurse
 * lent to another unit was invisible there: Generate could not use them, and the grid could not
 * judge their rest across the two units. A membership is the record that says "this unit may
 * schedule them too". The home unit is never a membership (it would be a second, drifting
 * statement of the same fact), and a membership cannot be taken away or narrowed past shifts the
 * nurse already holds on the unit, or the unit's own grid would hold a shift for someone it no
 * longer lists — and a `ScheduleView` throws on a nurse it does not know.
 *
 * Also here: the two reads that turn a membership into scheduling input — `listFloatNurses`
 * (who to append after the home roster) and `busyElsewhereFor` (the shifts those nurses, and the
 * home roster, work on other units, as core's `busyElsewhere` turns them into judged-but-never-
 * moved rows).
 */

import {
  type Assignment,
  type BusyElsewhere,
  busyElsewhere,
  compareDates,
  type Id,
  type IsoDate,
  type Nurse,
  type ShiftType,
} from '@shiftnurse/core';
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toAssignment, toNurse } from '../mappers.js';
import {
  assignment,
  nurse as nurseTable,
  schedulePeriod,
  nurseUnit as table,
  unit as unitTable,
} from '../schema.js';
import { listShiftTypesForUnit } from './config.js';
import { type PatchKeys, patchOf } from './patch.js';

const ENTITY = 'nurse_unit';

export interface NurseUnit {
  id: Id;
  nurseId: Id;
  /** A unit other than the nurse's home unit. */
  unitId: Id;
  /** What the nurse may be asked to do there, in the manager's words. */
  competency?: string;
  /** Inclusive; absent is open on that side. */
  startDate?: IsoDate;
  endDate?: IsoDate;
}

export type NurseUnitInput = Omit<NurseUnit, 'id'>;

/** The nurse and the unit never change: to move a membership, delete it and add another. */
export interface NurseUnitPatch {
  competency?: string | null;
  startDate?: IsoDate | null;
  endDate?: IsoDate | null;
}

const PATCH_KEYS: PatchKeys<NurseUnitPatch> = {
  competency: true,
  startDate: true,
  endDate: true,
};

function toNurseUnit(r: typeof table.$inferSelect): NurseUnit {
  return {
    id: r.id,
    nurseId: r.nurseId,
    unitId: r.unitId,
    ...(r.competency ? { competency: r.competency } : {}),
    ...(r.startDate ? { startDate: r.startDate } : {}),
    ...(r.endDate ? { endDate: r.endDate } : {}),
  };
}

export function listNurseUnitsForNurse(db: DbLike, nurseId: Id): NurseUnit[] {
  return db
    .select()
    .from(table)
    .where(eq(table.nurseId, nurseId))
    .orderBy(sql`${table}.rowid`)
    .all()
    .map(toNurseUnit);
}

export function listNurseUnitsForUnit(db: DbLike, unitId: Id): NurseUnit[] {
  return db
    .select()
    .from(table)
    .where(eq(table.unitId, unitId))
    .orderBy(sql`${table}.rowid`)
    .all()
    .map(toNurseUnit);
}

export function getNurseUnit(db: DbLike, id: Id): NurseUnit | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toNurseUnit(row) : undefined;
}

export function createNurseUnit(db: DbLike, input: NurseUnitInput, actor: string): NurseUnit {
  const record: NurseUnit = {
    id: ids.nurseUnit(),
    nurseId: input.nurseId,
    unitId: input.unitId,
    ...(input.competency?.trim() ? { competency: input.competency.trim() } : {}),
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.endDate ? { endDate: input.endDate } : {}),
  };
  validate(db, record);
  const existing = db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.nurseId, record.nurseId), eq(table.unitId, record.unitId)))
    .get();
  if (existing) {
    throw new Error(
      `${nameOf(db, record.nurseId)} already works on ${unitNameOf(db, record.unitId)}; edit that entry instead`,
    );
  }
  db.insert(table)
    .values({
      id: record.id,
      nurseId: record.nurseId,
      unitId: record.unitId,
      competency: record.competency ?? null,
      startDate: record.startDate ?? null,
      endDate: record.endDate ?? null,
      createdAt: Date.now(),
    })
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

export function updateNurseUnit(
  db: DbLike,
  id: Id,
  patch: NurseUnitPatch,
  actor: string,
): NurseUnit {
  const before = getNurseUnit(db, id);
  if (!before) throw new Error(`Float assignment ${id} not found`);
  const changes = patchOf(patch, PATCH_KEYS, 'float assignment');
  const after: NurseUnit = { ...before };
  // null clears a field, undefined leaves it: the form sends null for an emptied box.
  if ('competency' in changes) {
    if (changes.competency?.trim()) after.competency = changes.competency.trim();
    else delete after.competency;
  }
  if ('startDate' in changes) {
    if (changes.startDate) after.startDate = changes.startDate;
    else delete after.startDate;
  }
  if ('endDate' in changes) {
    if (changes.endDate) after.endDate = changes.endDate;
    else delete after.endDate;
  }
  validate(db, after);
  requireShiftsKept(db, after);
  db.update(table)
    .set({
      competency: after.competency ?? null,
      startDate: after.startDate ?? null,
      endDate: after.endDate ?? null,
    })
    .where(eq(table.id, id))
    .run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'update', actor, before, after });
  return after;
}

export function deleteNurseUnit(db: DbLike, id: Id, actor: string): void {
  const before = getNurseUnit(db, id);
  if (!before) throw new Error(`Float assignment ${id} not found`);
  requireShiftsKept(db, before, true);
  db.delete(table).where(eq(table.id, id)).run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'delete', actor, before });
}

function nameOf(db: DbLike, nurseId: Id): string {
  const row = db.select().from(nurseTable).where(eq(nurseTable.id, nurseId)).get();
  return row ? `${row.firstName} ${row.lastName}` : 'That nurse';
}

function unitNameOf(db: DbLike, unitId: Id): string {
  const row = db
    .select({ name: unitTable.name })
    .from(unitTable)
    .where(eq(unitTable.id, unitId))
    .get();
  return row?.name ?? 'that unit';
}

function validate(db: DbLike, record: NurseUnit): void {
  const nurse = db.select().from(nurseTable).where(eq(nurseTable.id, record.nurseId)).get();
  if (!nurse) throw new Error('That nurse is not on the roster');
  const unit = db.select().from(unitTable).where(eq(unitTable.id, record.unitId)).get();
  if (!unit) throw new Error('That unit does not exist');
  if (nurse.unitId === record.unitId) {
    throw new Error(
      `${unit.name} is already ${nurse.firstName} ${nurse.lastName}'s home unit; choose another unit to float to`,
    );
  }
  if (record.startDate && record.endDate && compareDates(record.endDate, record.startDate) < 0) {
    throw new Error('The float assignment ends before it starts');
  }
}

/**
 * The nurse's shifts on the unit must stay inside the membership: removing it (`removing`) or
 * narrowing its dates past one would leave a shift on a roster that no longer lists them.
 */
function requireShiftsKept(db: DbLike, record: NurseUnit, removing = false): void {
  const held = db
    .select({ date: assignment.date })
    .from(assignment)
    .innerJoin(schedulePeriod, eq(assignment.periodId, schedulePeriod.id))
    .where(and(eq(assignment.nurseId, record.nurseId), eq(schedulePeriod.unitId, record.unitId)))
    .all()
    .filter(
      (r) =>
        removing ||
        (record.startDate !== undefined && compareDates(r.date as IsoDate, record.startDate) < 0) ||
        (record.endDate !== undefined && compareDates(r.date as IsoDate, record.endDate) > 0),
    );
  if (held.length === 0) return;
  const who = nameOf(db, record.nurseId);
  const unit = unitNameOf(db, record.unitId);
  throw new Error(
    removing
      ? `${who} still has ${held.length} shift${held.length === 1 ? '' : 's'} on ${unit}; take them off the schedule before ending the float assignment`
      : `${who} has ${held.length} shift${held.length === 1 ? '' : 's'} on ${unit} outside those dates; move them first`,
  );
}

/**
 * Nurses from other units whose membership of `unitId` touches `[start, end]`, in the order the
 * memberships were made. Active or not, like the home roster: an inactive nurse's past shifts
 * still need a name on them. Appended after the home nurses by every caller, because array order
 * is behaviour in the solver and a unit with no memberships must solve exactly as before.
 */
export function listFloatNurses(db: DbLike, unitId: Id, start: IsoDate, end: IsoDate): Nurse[] {
  return db
    .select({ nurse: nurseTable })
    .from(table)
    .innerJoin(nurseTable, eq(table.nurseId, nurseTable.id))
    .where(
      and(
        eq(table.unitId, unitId),
        ne(nurseTable.unitId, unitId),
        or(isNull(table.startDate), lte(table.startDate, end)),
        or(isNull(table.endDate), gte(table.endDate, start)),
      ),
    )
    .orderBy(sql`${table}.rowid`)
    .all()
    .map((r) => toNurse(r.nurse));
}

/**
 * What these nurses work on other units' schedules in `[start, end]`, as `busyElsewhere` shapes
 * it. A unit's published schedule is what its nurses will work; a draft is what its manager is
 * planning, and either blocks the nurse here. (A nurse cannot hold the same shift on the same
 * date twice, in any period, so a draft laid over a published period never double-counts.)
 */
export function busyElsewhereFor(
  db: DbLike,
  unitId: Id,
  nurseIds: readonly Id[],
  start: IsoDate,
  end: IsoDate,
): BusyElsewhere {
  if (nurseIds.length === 0) return { shiftTypes: [], assignments: [] };
  const rows = db
    .select({ row: assignment, otherUnitId: schedulePeriod.unitId, status: schedulePeriod.status })
    .from(assignment)
    .innerJoin(schedulePeriod, eq(assignment.periodId, schedulePeriod.id))
    .where(
      and(
        inArray(assignment.nurseId, [...nurseIds]),
        ne(schedulePeriod.unitId, unitId),
        ne(schedulePeriod.status, 'archived'),
        gte(assignment.date, start),
        lte(assignment.date, end),
      ),
    )
    .orderBy(asc(schedulePeriod.unitId), asc(assignment.date), asc(assignment.id))
    .all();
  const byUnit = new Map<Id, Assignment[]>();
  for (const r of rows) {
    byUnit.set(r.otherUnitId, [...(byUnit.get(r.otherUnitId) ?? []), toAssignment(r.row)]);
  }
  const shiftTypes: ShiftType[] = [];
  const assignments: Assignment[] = [];
  for (const [otherUnitId, rowsOfUnit] of byUnit) {
    const busy = busyElsewhere(
      rowsOfUnit,
      listShiftTypesForUnit(db, otherUnitId),
      unitNameOf(db, otherUnitId),
    );
    shiftTypes.push(...busy.shiftTypes);
    assignments.push(...busy.assignments);
  }
  return { shiftTypes, assignments };
}
