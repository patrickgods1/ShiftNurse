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
  JurisdictionId,
  LeavePolicy,
  RatioStaffing,
  ShiftCredentialRequirement,
  ShiftType,
  Unit,
} from '@shiftnurse/core';
import { JURISDICTION_PRESETS, validateLeavePolicy, withinShiftProblem } from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import {
  ratioStaffingColumns,
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
import { auditedUpdate, type PatchKeys } from './patch.js';

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
  const { ratioStaffing, ...fields } = input;
  validateRatioStaffing(ratioStaffing);
  validatePostingLead(fields.postingLeadDays);
  if (fields.leavePolicy) validateLeavePolicy(fields.leavePolicy);
  const row: typeof unitTable.$inferInsert = {
    id,
    ...fields,
    ...ratioStaffingColumns(ratioStaffing),
  };
  db.insert(unitTable).values(row).run();
  const after = getUnit(db, id)!;
  recordAudit(db, { entityType: 'unit', entityId: id, action: 'create', actor, after });
  return after;
}

export interface UnitPatch {
  name?: string;
  unitType?: string;
  payPeriodDays?: number;
  payPeriodAnchor?: IsoDate;
  ratioStaffing?: RatioStaffing;
  /** Null clears the notice rule. */
  postingLeadDays?: number | null;
  /** Null forgets the state preset. */
  jurisdiction?: JurisdictionId | null;
  /** Null clears the policy: FMLA and balances revert to the pre-policy reading. */
  leavePolicy?: LeavePolicy | null;
}

const UNIT_PATCH_KEYS: PatchKeys<UnitPatch> = {
  name: true,
  unitType: true,
  payPeriodDays: true,
  payPeriodAnchor: true,
  ratioStaffing: true,
  postingLeadDays: true,
  jurisdiction: true,
  leavePolicy: true,
};

/** Break minutes are a whole number a shift can hold; anything else is a typing slip. */
function validateRatioStaffing(staffing: RatioStaffing | undefined): void {
  if (!staffing) return;
  const minutes = staffing.breakMinutesPerNurse;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240)
    throw new Error('Break minutes per nurse must be a whole number from 0 to 240');
}

function validatePostingLead(lead: number | null | undefined): void {
  if (lead === undefined || lead === null) return;
  if (!Number.isInteger(lead) || lead < 0 || lead > 90)
    throw new Error('Posting notice must be a whole number of days from 0 to 90');
}

export function updateUnit(db: DbLike, id: Id, patch: UnitPatch, actor: string): Unit {
  return auditedUpdate<Unit, UnitPatch>(db, {
    id,
    entityType: 'unit',
    entityLabel: 'unit',
    allowed: UNIT_PATCH_KEYS,
    patch,
    read: (rowId) => {
      const row = db.select().from(unitTable).where(eq(unitTable.id, rowId)).get();
      return row ? toUnit(row) : undefined;
    },
    // The id rides along so an empty patch still writes, as the full-row update always did.
    write: (rowId, { ratioStaffing, ...values }) =>
      db
        .update(unitTable)
        .set({ ...values, ...ratioStaffingColumns(ratioStaffing), id: rowId })
        .where(eq(unitTable.id, rowId))
        .run(),
    notFound: `Unit ${id} not found`,
    validate: (values) => {
      validateRatioStaffing(values.ratioStaffing);
      validatePostingLead(values.postingLeadDays);
      if (values.leavePolicy) validateLeavePolicy(values.leavePolicy);
      if (
        values.jurisdiction !== undefined &&
        values.jurisdiction !== null &&
        !Object.hasOwn(JURISDICTION_PRESETS, values.jurisdiction)
      )
        throw new Error(`Unknown state preset "${values.jurisdiction}"`);
      if (values.name !== undefined && values.name.trim() === '')
        throw new Error('A unit needs a name');
    },
    actor,
  });
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

/** A new shift type; standalone unless `withinShiftTypeId` names the shift it runs inside. */
export type NewShiftType = Omit<ShiftType, 'id' | 'withinShiftTypeId'> &
  Partial<Pick<ShiftType, 'withinShiftTypeId'>>;

/**
 * Refuse a shift type that would run inside a shift whose hours do not contain it, inside a
 * shift that itself runs inside another, or that other shifts run inside while it runs inside
 * one — so every shift inside another is covered by a standalone shift for all its hours.
 */
function assertCoverFits(db: DbLike, shiftType: ShiftType): void {
  const outer = shiftType.withinShiftTypeId
    ? getShiftType(db, shiftType.withinShiftTypeId)
    : undefined;
  const problem = withinShiftProblem(shiftType, outer);
  if (problem) throw new Error(problem);
  const inner = listShiftTypesForUnit(db, shiftType.unitId).filter(
    (t) => t.withinShiftTypeId === shiftType.id,
  );
  for (const t of inner) {
    const innerProblem = withinShiftProblem(t, shiftType);
    if (innerProblem) throw new Error(`${innerProblem}: ${t.name} runs inside ${shiftType.name}`);
  }
}

export function createShiftType(db: DbLike, input: NewShiftType, actor: string): ShiftType {
  const id = ids.shiftType();
  const row: typeof shiftTypeTable.$inferInsert = {
    id,
    ...input,
    withinShiftTypeId: input.withinShiftTypeId ?? null,
  };
  assertCoverFits(db, toShiftType(row as typeof shiftTypeTable.$inferSelect));
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
  withinShiftTypeId?: Id | null;
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
  withinShiftTypeId: true,
};

export function updateShiftType(
  db: DbLike,
  id: Id,
  patch: ShiftTypePatch,
  actor: string,
): ShiftType {
  return auditedUpdate<ShiftType, ShiftTypePatch>(db, {
    id,
    entityType: 'shift_type',
    entityLabel: 'shift type',
    allowed: SHIFT_TYPE_PATCH_KEYS,
    patch,
    read: (rowId) => {
      const row = db.select().from(shiftTypeTable).where(eq(shiftTypeTable.id, rowId)).get();
      return row ? toShiftType(row) : undefined;
    },
    // The id rides along so an empty patch still writes, as the full-row update always did.
    write: (rowId, values) =>
      db
        .update(shiftTypeTable)
        .set({ ...values, id: rowId })
        .where(eq(shiftTypeTable.id, rowId))
        .run(),
    notFound: `Shift type ${id} not found`,
    // A new time or length can stop it fitting inside its shift, or stop another fitting inside it.
    validate: (values, before) => assertCoverFits(db, { ...before, ...values }),
    actor,
  });
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
