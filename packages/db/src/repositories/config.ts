/**
 * Unit configuration repository: the unit itself, shift types, coverage floors, holidays and
 * shift credential requirements. Acuity (tiers, ratios, HPPD) is in `acuity.ts`, rule sets in
 * `rulesets.ts`.
 *
 * This is the slowest-moving data in the system — a manager edits it a handful of times a
 * year — but it is what every solve and every compliance report is judged against, so reads
 * here favour returning a complete, ready-to-use shape (see `getRuleSet`/`getLatestRuleSet`)
 * over a thin row projection the caller has to reassemble itself.
 */

import type {
  CoverageRequirement,
  Holiday,
  Id,
  IsoDate,
  ShiftCredentialRequirement,
  ShiftType,
  Unit,
} from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import {
  toCoverageRequirement,
  toCredentialRequirement,
  toHoliday,
  toShiftType,
  toUnit,
} from '../mappers.js';
import {
  coverageRequirement as coverageRequirementTable,
  holiday as holidayTable,
  shiftCredentialRequirement as shiftCredentialRequirementTable,
  shiftType as shiftTypeTable,
  unit as unitTable,
} from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export function listUnits(db: DbLike): Unit[] {
  return db.select().from(unitTable).orderBy(asc(unitTable.name)).all().map(toUnit);
}

export function getUnit(db: DbLike, id: Id): Unit | undefined {
  const row = db.select().from(unitTable).where(eq(unitTable.id, id)).get();
  return row ? toUnit(row) : undefined;
}

export function createUnit(db: DbLike, input: Omit<Unit, 'id'>, actor: string): Unit {
  const id = ids.unit();
  const row: typeof unitTable.$inferInsert = { id, ...input };
  db.insert(unitTable).values(row).run();
  const after = toUnit(row as typeof unitTable.$inferSelect);
  recordAudit(db, { entityType: 'unit', entityId: id, action: 'create', actor, after });
  return after;
}

export interface UnitPatch {
  name?: string;
  unitType?: string;
  payPeriodDays?: number;
  payPeriodAnchor?: IsoDate;
}

const UNIT_PATCH_KEYS: PatchKeys<UnitPatch> = {
  name: true,
  unitType: true,
  payPeriodDays: true,
  payPeriodAnchor: true,
};

export function updateUnit(db: DbLike, id: Id, patch: UnitPatch, actor: string): Unit {
  const row = db.select().from(unitTable).where(eq(unitTable.id, id)).get();
  if (!row) throw new Error(`Unit ${id} not found`);
  const before = toUnit(row);
  const merged = { ...row, ...patchOf(patch, UNIT_PATCH_KEYS, 'unit') };
  db.update(unitTable).set(merged).where(eq(unitTable.id, id)).run();
  const after = toUnit(merged);
  recordAudit(db, { entityType: 'unit', entityId: id, action: 'update', actor, before, after });
  return after;
}

// ---------------------------------------------------------------------------
// Shift types
// ---------------------------------------------------------------------------

export function listShiftTypesForUnit(db: DbLike, unitId: Id): ShiftType[] {
  return db
    .select()
    .from(shiftTypeTable)
    .where(eq(shiftTypeTable.unitId, unitId))
    .orderBy(asc(shiftTypeTable.sortOrder))
    .all()
    .map(toShiftType);
}

export function getShiftType(db: DbLike, id: Id): ShiftType | undefined {
  const row = db.select().from(shiftTypeTable).where(eq(shiftTypeTable.id, id)).get();
  return row ? toShiftType(row) : undefined;
}

export function createShiftType(
  db: DbLike,
  input: Omit<ShiftType, 'id'>,
  actor: string,
): ShiftType {
  const id = ids.shiftType();
  const row: typeof shiftTypeTable.$inferInsert = { id, ...input };
  db.insert(shiftTypeTable).values(row).run();
  const after = toShiftType(row as typeof shiftTypeTable.$inferSelect);
  recordAudit(db, { entityType: 'shift_type', entityId: id, action: 'create', actor, after });
  return after;
}

export interface ShiftTypePatch {
  name?: string;
  abbreviation?: string;
  startTime?: string;
  durationHours?: number;
  isNight?: boolean;
  isOnCall?: boolean;
  color?: string;
  sortOrder?: number;
  active?: boolean;
}

const SHIFT_TYPE_PATCH_KEYS: PatchKeys<ShiftTypePatch> = {
  name: true,
  abbreviation: true,
  startTime: true,
  durationHours: true,
  isNight: true,
  isOnCall: true,
  color: true,
  sortOrder: true,
  active: true,
};

export function updateShiftType(
  db: DbLike,
  id: Id,
  patch: ShiftTypePatch,
  actor: string,
): ShiftType {
  const row = db.select().from(shiftTypeTable).where(eq(shiftTypeTable.id, id)).get();
  if (!row) throw new Error(`Shift type ${id} not found`);
  const before = toShiftType(row);
  const merged = { ...row, ...patchOf(patch, SHIFT_TYPE_PATCH_KEYS, 'shift type') };
  db.update(shiftTypeTable).set(merged).where(eq(shiftTypeTable.id, id)).run();
  const after = toShiftType(merged);
  recordAudit(db, {
    entityType: 'shift_type',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

/**
 * Deactivate rather than delete: past periods, assignments and coverage requirements still
 * reference this shift type, and deleting it would either cascade away that history or leave
 * those rows pointing at nothing.
 */
export function deactivateShiftType(db: DbLike, id: Id, actor: string): ShiftType {
  const row = db.select().from(shiftTypeTable).where(eq(shiftTypeTable.id, id)).get();
  if (!row) throw new Error(`Shift type ${id} not found`);
  const before = toShiftType(row);
  const merged = { ...row, active: false };
  db.update(shiftTypeTable).set(merged).where(eq(shiftTypeTable.id, id)).run();
  const after = toShiftType(merged);
  recordAudit(db, {
    entityType: 'shift_type',
    entityId: id,
    action: 'delete',
    actor,
    before,
    after,
  });
  return after;
}

// ---------------------------------------------------------------------------
// Coverage requirements
// ---------------------------------------------------------------------------

export function listCoverageRequirementsForUnit(db: DbLike, unitId: Id): CoverageRequirement[] {
  return db
    .select()
    .from(coverageRequirementTable)
    .where(eq(coverageRequirementTable.unitId, unitId))
    .all()
    .map(toCoverageRequirement);
}

/** Create when `input.id` is absent, otherwise update the existing row in place. */
export function upsertCoverageRequirement(
  db: DbLike,
  input: Omit<CoverageRequirement, 'id'> & { id?: Id },
  actor: string,
): CoverageRequirement {
  if (input.id !== undefined) {
    const row = db
      .select()
      .from(coverageRequirementTable)
      .where(eq(coverageRequirementTable.id, input.id))
      .get();
    if (!row) throw new Error(`Coverage requirement ${input.id} not found`);
    const before = toCoverageRequirement(row);
    const merged = {
      ...row,
      shiftTypeId: input.shiftTypeId,
      weekday: input.weekday,
      date: input.date,
      role: input.role,
      minCount: input.minCount,
      targetCount: input.targetCount,
    };
    db.update(coverageRequirementTable)
      .set(merged)
      .where(eq(coverageRequirementTable.id, input.id))
      .run();
    const after = toCoverageRequirement(merged);
    recordAudit(db, {
      entityType: 'coverage_requirement',
      entityId: input.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }
  const id = ids.coverage();
  const row: typeof coverageRequirementTable.$inferInsert = {
    id,
    unitId: input.unitId,
    shiftTypeId: input.shiftTypeId,
    weekday: input.weekday,
    date: input.date,
    role: input.role,
    minCount: input.minCount,
    targetCount: input.targetCount,
  };
  db.insert(coverageRequirementTable).values(row).run();
  const after = toCoverageRequirement(row as typeof coverageRequirementTable.$inferSelect);
  recordAudit(db, {
    entityType: 'coverage_requirement',
    entityId: id,
    action: 'create',
    actor,
    after,
  });
  return after;
}

export function deleteCoverageRequirement(db: DbLike, id: Id, actor: string): void {
  const row = db
    .select()
    .from(coverageRequirementTable)
    .where(eq(coverageRequirementTable.id, id))
    .get();
  if (!row) throw new Error(`Coverage requirement ${id} not found`);
  const before = toCoverageRequirement(row);
  db.delete(coverageRequirementTable).where(eq(coverageRequirementTable.id, id)).run();
  recordAudit(db, {
    entityType: 'coverage_requirement',
    entityId: id,
    action: 'delete',
    actor,
    before,
  });
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export function listHolidaysForUnit(db: DbLike, unitId: Id): Holiday[] {
  return db.select().from(holidayTable).where(eq(holidayTable.unitId, unitId)).all().map(toHoliday);
}

export function listHolidaysInRange(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): Holiday[] {
  return db
    .select()
    .from(holidayTable)
    .where(
      and(
        eq(holidayTable.unitId, unitId),
        gte(holidayTable.date, start),
        lte(holidayTable.date, end),
      ),
    )
    .all()
    .map(toHoliday);
}

export function createHoliday(db: DbLike, input: Omit<Holiday, 'id'>, actor: string): Holiday {
  const id = ids.holiday();
  const row: typeof holidayTable.$inferInsert = { id, ...input };
  db.insert(holidayTable).values(row).run();
  const after = toHoliday(row as typeof holidayTable.$inferSelect);
  recordAudit(db, { entityType: 'holiday', entityId: id, action: 'create', actor, after });
  return after;
}

export function deleteHoliday(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(holidayTable).where(eq(holidayTable.id, id)).get();
  if (!row) throw new Error(`Holiday ${id} not found`);
  const before = toHoliday(row);
  db.delete(holidayTable).where(eq(holidayTable.id, id)).run();
  recordAudit(db, { entityType: 'holiday', entityId: id, action: 'delete', actor, before });
}

// ---------------------------------------------------------------------------
// Shift credential requirements
// ---------------------------------------------------------------------------

export function listShiftCredentialRequirementsForUnit(
  db: DbLike,
  unitId: Id,
): ShiftCredentialRequirement[] {
  return db
    .select()
    .from(shiftCredentialRequirementTable)
    .where(eq(shiftCredentialRequirementTable.unitId, unitId))
    .all()
    .map(toCredentialRequirement);
}

export function createShiftCredentialRequirement(
  db: DbLike,
  input: Omit<ShiftCredentialRequirement, 'id'>,
  actor: string,
): ShiftCredentialRequirement {
  const id = ids.credentialRequirement();
  const row: typeof shiftCredentialRequirementTable.$inferInsert = { id, ...input };
  db.insert(shiftCredentialRequirementTable).values(row).run();
  const after = toCredentialRequirement(row as typeof shiftCredentialRequirementTable.$inferSelect);
  recordAudit(db, {
    entityType: 'shift_credential_requirement',
    entityId: id,
    action: 'create',
    actor,
    after,
  });
  return after;
}

export function deleteShiftCredentialRequirement(db: DbLike, id: Id, actor: string): void {
  const row = db
    .select()
    .from(shiftCredentialRequirementTable)
    .where(eq(shiftCredentialRequirementTable.id, id))
    .get();
  if (!row) throw new Error(`Shift credential requirement ${id} not found`);
  const before = toCredentialRequirement(row);
  db.delete(shiftCredentialRequirementTable)
    .where(eq(shiftCredentialRequirementTable.id, id))
    .run();
  recordAudit(db, {
    entityType: 'shift_credential_requirement',
    entityId: id,
    action: 'delete',
    actor,
    before,
  });
}
