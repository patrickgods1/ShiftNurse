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
  JurisdictionChoices,
  JurisdictionId,
  LeavePolicy,
  NurseRole,
  OvertimeOrder,
  PaperSize,
  PerDiemCommitment,
  RatioStaffing,
  ShiftCredentialRequirement,
  ShiftType,
  Unit,
} from '@shiftnurse/core';
import {
  describeDate,
  isIsoDate,
  JURISDICTION_PRESETS,
  validateLeavePolicy,
  WEEKDAY_NAMES,
  withinShiftProblem,
} from '@shiftnurse/core';
import { and, asc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
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

/**
 * The unit the app opens. `listUnits` is alphabetical for pickers, so its first entry is
 * whichever name sorts first, and a renamed home unit could lose that place to a float sibling.
 */
export function getHomeUnit(db: DbLike): Unit | undefined {
  const row = db.select().from(unitTable).where(eq(unitTable.isHome, true)).get();
  return row ? toUnit(row) : undefined;
}

export function createUnit(db: DbLike, input: Omit<Unit, 'id'>, actor: string): Unit {
  const id = ids.unit();
  const { ratioStaffing, ...fields } = input;
  validateRatioStaffing(ratioStaffing);
  validatePostingLead(fields.postingLeadDays);
  if (fields.leavePolicy) validateLeavePolicy(fields.leavePolicy);
  // The first unit on a file is the one the manager set up; any later one is a float sibling.
  const isHome = db.select({ id: unitTable.id }).from(unitTable).limit(1).get() === undefined;
  const row: typeof unitTable.$inferInsert = {
    id,
    ...fields,
    ...ratioStaffingColumns(ratioStaffing),
    isHome,
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
  /** Null forgets the answers: every question reads as no. */
  jurisdictionChoices?: JurisdictionChoices | null;
  /** Null clears the policy: FMLA and balances revert to the pre-policy reading. */
  leavePolicy?: LeavePolicy | null;
  /** Null returns day-of to the cost-first overtime order. */
  overtimeOrder?: OvertimeOrder | null;
  /** Null stops checking per-diem commitments. */
  perDiemCommitment?: PerDiemCommitment | null;
  /** Null: a reason is enough for a change to a posted schedule. */
  requireConsentForPostedChanges?: boolean | null;
  /** Null stops checking. */
  minWeekendsOffPerYear?: number | null;
  /** Null follows the computer's region. */
  paperSize?: PaperSize | null;
}

const UNIT_PATCH_KEYS: PatchKeys<UnitPatch> = {
  name: true,
  unitType: true,
  payPeriodDays: true,
  payPeriodAnchor: true,
  ratioStaffing: true,
  postingLeadDays: true,
  jurisdiction: true,
  jurisdictionChoices: true,
  leavePolicy: true,
  overtimeOrder: true,
  perDiemCommitment: true,
  requireConsentForPostedChanges: true,
  minWeekendsOffPerYear: true,
  paperSize: true,
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

function validateWeekendsOff(count: number | null | undefined): void {
  if (count === undefined || count === null) return;
  if (!Number.isInteger(count) || count < 0 || count > 52)
    throw new Error('Weekends off per year must be a whole number from 0 to 52');
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
    write: (rowId, { ratioStaffing, ...values }) =>
      db
        .update(unitTable)
        .set({ ...values, ...ratioStaffingColumns(ratioStaffing) })
        .where(eq(unitTable.id, rowId))
        .run(),
    notFound: `Unit ${id} not found`,
    validate: (values) => {
      validateRatioStaffing(values.ratioStaffing);
      validatePostingLead(values.postingLeadDays);
      validateWeekendsOff(values.minWeekendsOffPerYear);
      if (values.paperSize != null && values.paperSize !== 'letter' && values.paperSize !== 'a4')
        throw new Error('Paper size must be Letter or A4.');
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
    write: (rowId, values) =>
      db.update(shiftTypeTable).set(values).where(eq(shiftTypeTable.id, rowId)).run(),
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
  return (
    db
      .select()
      .from(coverageRequirementTable)
      .where(eq(coverageRequirementTable.unitId, unitId))
      // Core keeps the last matching floor it is handed, so the order it sees must be defined.
      .orderBy(sql`rowid`)
      .all()
      .map(toCoverageRequirement)
  );
}

/** "on Mondays" or "for Fri Dec 25, 2026": the day a floor applies to, in a manager's words. */
function describeFloorDay(weekday: number | null, date: IsoDate | null): string {
  if (date !== null) return `for ${describeDate(date, { year: true })}`;
  return `on ${WEEKDAY_NAMES[weekday!]}s`;
}

/**
 * Everything a floor must satisfy before it is stored, in the order a manager would hit it. The
 * repository is the single gate: seeds and presets bypass the IPC schema, and a floor that core
 * silently reads differently (both day fields, min above target, a second row for the same day)
 * changes staffing with no error anywhere.
 */
function assertCoverageFloor(
  db: DbLike,
  input: Omit<CoverageRequirement, 'id'> & { id?: Id },
): void {
  const { weekday, date } = input;
  if (weekday === null && date === null)
    throw new Error('Choose a weekday or a date for this floor.');
  if (weekday !== null && date !== null) {
    throw new Error('A floor is for a weekday or for one date, not both.');
  }
  if (weekday !== null && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) {
    throw new Error('A weekday is 0 (Sunday) to 6 (Saturday).');
  }
  if (date !== null && !isIsoDate(date)) throw new Error("The floor's date is not a date.");
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  if (!whole(input.minCount) || !whole(input.targetCount)) {
    throw new Error("A floor's minimum and target are whole numbers of nurses, zero or more.");
  }
  const shift = db
    .select()
    .from(shiftTypeTable)
    .where(eq(shiftTypeTable.id, input.shiftTypeId))
    .get();
  const name = shift?.name ?? '';
  if (input.minCount > input.targetCount) {
    // Name the shift only once we know it; an unknown one is refused just below.
    if (shift) {
      throw new Error(
        `The ${input.role} floor for ${name} ${describeFloorDay(weekday, date)} has a minimum of ${input.minCount} above its target of ${input.targetCount}; raise the target or lower the minimum.`,
      );
    }
  }
  if (!shift) throw new Error('That shift type was not found. Reload the page.');
  if (shift.unitId !== input.unitId) {
    const unitName = (id: Id) => getUnit(db, id)?.name ?? 'another unit';
    throw new Error(
      `${name} is a shift on ${unitName(shift.unitId)}, not on ${unitName(input.unitId)}.`,
    );
  }
  const clash = db
    .select({ id: coverageRequirementTable.id })
    .from(coverageRequirementTable)
    .where(
      and(
        eq(coverageRequirementTable.unitId, input.unitId),
        eq(coverageRequirementTable.shiftTypeId, input.shiftTypeId),
        eq(coverageRequirementTable.role, input.role),
        date !== null
          ? eq(coverageRequirementTable.date, date)
          : and(
              sql`${coverageRequirementTable.date} is null`,
              eq(coverageRequirementTable.weekday, weekday!),
            ),
        input.id !== undefined ? ne(coverageRequirementTable.id, input.id) : undefined,
      ),
    )
    .get();
  if (clash) {
    throw new Error(
      `${name} already has ${input.role === 'CNA' ? 'a' : 'an'} ${input.role} floor ${describeFloorDay(weekday, date).replace(/^on /, 'for ')}; change that one instead.`,
    );
  }
}

/**
 * Set one shift type and role to the same minimum and target on every weekday. Takes the
 * transaction because seven writes are only correct together: a failure part-way would leave the
 * week half-filled. Days already at those numbers write nothing (see the upsert).
 */
export function fillCoverageWeek(
  tx: ShiftNurseTx,
  input: { unitId: Id; shiftTypeId: Id; role: NurseRole; minCount: number; targetCount: number },
  actor: string,
): CoverageRequirement[] {
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  if (!whole(input.minCount) || !whole(input.targetCount)) {
    throw new Error('Coverage counts must be whole numbers, zero or more.');
  }
  if (input.targetCount < input.minCount)
    throw new Error('The target cannot be below the minimum.');
  const existing = listCoverageRequirementsForUnit(tx, input.unitId).filter(
    (r) => r.date === null && r.shiftTypeId === input.shiftTypeId && r.role === input.role,
  );
  return ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) =>
    upsertCoverageRequirement(
      tx,
      {
        id: existing.find((r) => r.weekday === weekday)?.id,
        unitId: input.unitId,
        shiftTypeId: input.shiftTypeId,
        weekday,
        date: null,
        role: input.role,
        minCount: input.minCount,
        targetCount: input.targetCount,
      },
      actor,
    ),
  );
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
    if (input.unitId !== row.unitId)
      throw new Error('A coverage floor cannot move to another unit.');
    assertCoverageFloor(db, input);
    const before = toCoverageRequirement(row);
    // A cell left as it was is not an event: an audited no-op would bury the real edits.
    if (
      before.shiftTypeId === input.shiftTypeId &&
      before.weekday === input.weekday &&
      before.date === input.date &&
      before.role === input.role &&
      before.minCount === input.minCount &&
      before.targetCount === input.targetCount
    ) {
      return before;
    }
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
  assertCoverageFloor(db, input);
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
