/**
 * Roster repository: nurses, their credentials and their scheduling preferences.
 *
 * Every function takes `DbLike` rather than `ShiftNurseDb` so a caller assembling a bigger
 * transaction — importing a CSV of forty nurses, or replacing a nurse's preferences as part
 * of saving their whole profile — can call these functions once per row inside its own
 * `transact()` and get one atomic commit instead of composing transactions.
 */

import type {
  Credential,
  EmploymentType,
  Id,
  IsoDate,
  Nurse,
  NurseCredential,
  NurseRole,
  Preference,
  ScheduleKind,
  Tour,
} from '@shiftnurse/core';
import { addDays, SCHEDULE_KINDS } from '@shiftnurse/core';
import { and, asc, eq, gte, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import {
  fromPreference,
  toCredential,
  toNurse,
  toNurseCredential,
  toPreference,
} from '../mappers.js';
import {
  credential as credentialTable,
  nurseCredential as nurseCredentialTable,
  nurse as nurseTable,
  nurseUnit as nurseUnitTable,
  preference as preferenceTable,
} from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

function getNurseRowOrThrow(db: DbLike, id: Id): typeof nurseTable.$inferSelect {
  const row = db.select().from(nurseTable).where(eq(nurseTable.id, id)).get();
  if (!row) throw new Error(`Nurse ${id} not found`);
  return row;
}

/** IPC input is typed, not checked: refuse a plan pricing and the tour-plan rule cannot read. */
function checkScheduleKind(kind: string | null | undefined): void {
  if (kind != null && !(SCHEDULE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Schedule kind "${kind}" is not one of ${SCHEDULE_KINDS.join(', ')}`);
  }
}

function buildNurseRow(id: Id, input: Omit<Nurse, 'id'>): typeof nurseTable.$inferInsert {
  checkScheduleKind(input.scheduleKind);
  return {
    id,
    unitId: input.unitId,
    employeeId: input.employeeId,
    firstName: input.firstName,
    lastName: input.lastName,
    role: input.role,
    employmentType: input.employmentType,
    fte: input.fte,
    contractedHoursPerPeriod: input.contractedHoursPerPeriod,
    seniorityDate: input.seniorityDate,
    hireDate: input.hireDate ?? null,
    permanentTour: input.permanentTour ?? null,
    scheduledDaysPerWeek: input.scheduledDaysPerWeek ?? null,
    scheduleKind: input.scheduleKind ?? null,
    isChargeEligible: input.isChargeEligible,
    isNovice: input.isNovice,
    isFloatEligible: input.isFloatEligible,
    phone: input.phone ?? null,
    email: input.email ?? null,
    active: input.active,
    notes: input.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Nurses
// ---------------------------------------------------------------------------

export function listNursesForUnit(db: DbLike, unitId: Id): Nurse[] {
  return db.select().from(nurseTable).where(eq(nurseTable.unitId, unitId)).all().map(toNurse);
}

export function listActiveNursesForUnit(db: DbLike, unitId: Id): Nurse[] {
  return db
    .select()
    .from(nurseTable)
    .where(and(eq(nurseTable.unitId, unitId), eq(nurseTable.active, true)))
    .all()
    .map(toNurse);
}

export function getNurse(db: DbLike, id: Id): Nurse | undefined {
  const row = db.select().from(nurseTable).where(eq(nurseTable.id, id)).get();
  return row ? toNurse(row) : undefined;
}

export function getNurseByEmployeeId(
  db: DbLike,
  unitId: Id,
  employeeId: string,
): Nurse | undefined {
  const row = db
    .select()
    .from(nurseTable)
    .where(and(eq(nurseTable.unitId, unitId), eq(nurseTable.employeeId, employeeId)))
    .get();
  return row ? toNurse(row) : undefined;
}

/** Active nurses, earliest `seniorityDate` (most senior) first. Feeds fairness and tie-breaks. */
export function nursesBySeniority(db: DbLike, unitId: Id): Nurse[] {
  return db
    .select()
    .from(nurseTable)
    .where(and(eq(nurseTable.unitId, unitId), eq(nurseTable.active, true)))
    .orderBy(asc(nurseTable.seniorityDate))
    .all()
    .map(toNurse);
}

export function createNurse(db: DbLike, input: Omit<Nurse, 'id'>, actor: string): Nurse {
  const id = ids.nurse();
  const row = buildNurseRow(id, input);
  db.insert(nurseTable).values(row).run();
  const after = toNurse(row as typeof nurseTable.$inferSelect);
  recordAudit(db, { entityType: 'nurse', entityId: id, action: 'create', actor, after });
  return after;
}

/**
 * Bulk insert for CSV import. One audit entry per nurse, action `'import'`, so the audit
 * history distinguishes "the manager typed this in" from "this arrived in a spreadsheet".
 */
export function insertNurses(
  db: DbLike,
  nurses: readonly Omit<Nurse, 'id'>[],
  actor: string,
): Nurse[] {
  if (nurses.length === 0) return [];
  const rows = nurses.map((n) => buildNurseRow(ids.nurse(), n));
  db.insert(nurseTable).values(rows).run();
  const created = rows.map((r) => toNurse(r as typeof nurseTable.$inferSelect));
  for (const n of created) {
    recordAudit(db, { entityType: 'nurse', entityId: n.id, action: 'import', actor, after: n });
  }
  return created;
}

/**
 * Fields a patch may set. Optional-and-clearable fields (`phone`, `email`, `notes`) take
 * `null` to explicitly clear them; omitting a key entirely leaves it untouched.
 */
export interface NursePatch {
  employeeId?: string;
  firstName?: string;
  lastName?: string;
  role?: NurseRole;
  employmentType?: EmploymentType;
  fte?: number;
  contractedHoursPerPeriod?: number;
  seniorityDate?: IsoDate;
  /** `null` clears it: the seniority date is then the start of employment. */
  hireDate?: IsoDate | null;
  /** `null` returns the nurse to the rotation. */
  permanentTour?: Tour | null;
  /** `null` clears it: no 'beyond_scheduled_days' overtime is priced for the nurse. */
  scheduledDaysPerWeek?: number | null;
  /** `null` clears it: the nurse is standard. */
  scheduleKind?: ScheduleKind | null;
  isChargeEligible?: boolean;
  isNovice?: boolean;
  isFloatEligible?: boolean;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean;
}

const NURSE_PATCH_KEYS: PatchKeys<NursePatch> = {
  employeeId: true,
  firstName: true,
  lastName: true,
  role: true,
  employmentType: true,
  fte: true,
  contractedHoursPerPeriod: true,
  seniorityDate: true,
  hireDate: true,
  permanentTour: true,
  scheduledDaysPerWeek: true,
  scheduleKind: true,
  isChargeEligible: true,
  isNovice: true,
  isFloatEligible: true,
  phone: true,
  email: true,
  notes: true,
  active: true,
};

export function updateNurse(db: DbLike, id: Id, patch: NursePatch, actor: string): Nurse {
  const row = getNurseRowOrThrow(db, id);
  const before = toNurse(row);
  const values = patchOf(patch, NURSE_PATCH_KEYS, 'nurse');
  checkScheduleKind(values.scheduleKind);
  const merged = { ...row, ...values };
  db.update(nurseTable).set(merged).where(eq(nurseTable.id, id)).run();
  const after = toNurse(merged);
  recordAudit(db, { entityType: 'nurse', entityId: id, action: 'update', actor, before, after });
  return after;
}

/**
 * Deactivate rather than delete. A nurse who has worked historical assignments and has audit
 * entries pointing at them must not vanish — deleting the row would either cascade-delete
 * every schedule they were ever on, or leave assignments and audit entries referring to a
 * nurse that no longer exists, and a published schedule would lose its meaning either way.
 * Audited as an update: it is one, and the record must read the same whichever path the manager
 * took.
 */
export function deactivateNurse(db: DbLike, id: Id, actor: string): Nurse {
  return updateNurse(db, id, { active: false }, actor);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function listCredentials(db: DbLike): Credential[] {
  return db.select().from(credentialTable).all().map(toCredential);
}

/** Every nurse credential on a unit, for building a rule-evaluation context in one query. */
export function listNurseCredentialsForUnit(db: DbLike, unitId: Id): NurseCredential[] {
  return db
    .select({ nurseCredential: nurseCredentialTable })
    .from(nurseCredentialTable)
    .innerJoin(nurseTable, eq(nurseCredentialTable.nurseId, nurseTable.id))
    .where(eq(nurseTable.unitId, unitId))
    .all()
    .map((r) => toNurseCredential(r.nurseCredential));
}

export function listNurseCredentials(db: DbLike, nurseId: Id): NurseCredential[] {
  return db
    .select()
    .from(nurseCredentialTable)
    .where(eq(nurseCredentialTable.nurseId, nurseId))
    .all()
    .map(toNurseCredential);
}

export function grantCredential(
  db: DbLike,
  input: Omit<NurseCredential, 'id'>,
  actor: string,
): NurseCredential {
  const id = ids.nurseCredential();
  const row: typeof nurseCredentialTable.$inferInsert = {
    id,
    nurseId: input.nurseId,
    credentialId: input.credentialId,
    issuedOn: input.issuedOn ?? null,
    expiresOn: input.expiresOn ?? null,
  };
  db.insert(nurseCredentialTable).values(row).run();
  const after = toNurseCredential(row as typeof nurseCredentialTable.$inferSelect);
  recordAudit(db, { entityType: 'nurse_credential', entityId: id, action: 'create', actor, after });
  return after;
}

export function updateCredentialExpiry(
  db: DbLike,
  id: Id,
  expiresOn: IsoDate | undefined,
  actor: string,
): NurseCredential {
  const row = db.select().from(nurseCredentialTable).where(eq(nurseCredentialTable.id, id)).get();
  if (!row) throw new Error(`Nurse credential ${id} not found`);
  const before = toNurseCredential(row);
  const merged = { ...row, expiresOn: expiresOn ?? null };
  db.update(nurseCredentialTable).set(merged).where(eq(nurseCredentialTable.id, id)).run();
  const after = toNurseCredential(merged);
  recordAudit(db, {
    entityType: 'nurse_credential',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

export function revokeCredential(db: DbLike, id: Id, actor: string): void {
  const row = db.select().from(nurseCredentialTable).where(eq(nurseCredentialTable.id, id)).get();
  if (!row) throw new Error(`Nurse credential ${id} not found`);
  const before = toNurseCredential(row);
  db.delete(nurseCredentialTable).where(eq(nurseCredentialTable.id, id)).run();
  recordAudit(db, {
    entityType: 'nurse_credential',
    entityId: id,
    action: 'delete',
    actor,
    before,
  });
}

/** One row per (nurse, credential) pair, enough to render "N nurses' ACLS expires here". */
export interface ExpiringCredential {
  nurse: Nurse;
  credential: Credential;
  nurseCredential: NurseCredential;
}

/**
 * Whether the nurse works `unitId` at some point in `[from, to]`: homed there, or a float with a
 * membership of it touching the range. Without the float arm a floated-in nurse's lapsing ACLS
 * never reaches the unit whose shifts she takes. Active-only is the caller's `WHERE`.
 */
function worksOnUnitBetween(unitId: Id, from: IsoDate, to: IsoDate) {
  return or(
    eq(nurseTable.unitId, unitId),
    and(
      isNotNull(nurseUnitTable.id),
      or(isNull(nurseUnitTable.startDate), lte(nurseUnitTable.startDate, to)),
      or(isNull(nurseUnitTable.endDate), gte(nurseUnitTable.endDate, from)),
    ),
  );
}

/**
 * Credentials expiring inside `[start, end]` of the active nurses who work `unitId`: those homed
 * there and the floats whose membership of it touches the window. Not every nurse in the
 * database: another unit's nurses and people who have left are not this manager's to chase.
 * Soonest first, then by name, so the dashboard list does not reshuffle between loads. Drives the
 * compliance alert.
 */
export function credentialsExpiringBetween(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): ExpiringCredential[] {
  const rows = db
    .select({
      nurse: nurseTable,
      credential: credentialTable,
      nurseCredential: nurseCredentialTable,
    })
    .from(nurseCredentialTable)
    .innerJoin(nurseTable, eq(nurseCredentialTable.nurseId, nurseTable.id))
    .innerJoin(credentialTable, eq(nurseCredentialTable.credentialId, credentialTable.id))
    .leftJoin(
      nurseUnitTable,
      and(eq(nurseUnitTable.nurseId, nurseTable.id), eq(nurseUnitTable.unitId, unitId)),
    )
    .where(
      and(
        eq(nurseTable.active, true),
        worksOnUnitBetween(unitId, start, end),
        isNotNull(nurseCredentialTable.expiresOn),
        gte(nurseCredentialTable.expiresOn, start),
        lte(nurseCredentialTable.expiresOn, end),
      ),
    )
    .orderBy(
      asc(nurseCredentialTable.expiresOn),
      asc(nurseTable.lastName),
      asc(nurseTable.firstName),
      asc(nurseTable.id),
      asc(credentialTable.code),
    )
    .all();
  return rows.map((r) => ({
    nurse: toNurse(r.nurse),
    credential: toCredential(r.credential),
    nurseCredential: toNurseCredential(r.nurseCredential),
  }));
}

/**
 * Credentials of active nurses who work the unit (home nurses and floats whose membership touches
 * the lookback window) that lapsed in the `lookbackDays` before `onDate`, oldest first. The expiry
 * day itself is the last valid day (`credentialLapsedOn`). A renewal is recorded by editing the
 * date in place (`updateCredentialExpiry`): `nurse_credential` is unique per nurse and
 * credential, so there is never a second, newer record to look for. The window is bounded so
 * years-old history never floods the list.
 */
export function lapsedCredentialsForUnit(
  db: DbLike,
  unitId: Id,
  onDate: IsoDate,
  lookbackDays = 365,
): ExpiringCredential[] {
  const earliest = addDays(onDate, -lookbackDays);
  const rows = db
    .select({
      nurse: nurseTable,
      credential: credentialTable,
      nurseCredential: nurseCredentialTable,
    })
    .from(nurseCredentialTable)
    .innerJoin(nurseTable, eq(nurseCredentialTable.nurseId, nurseTable.id))
    .innerJoin(credentialTable, eq(nurseCredentialTable.credentialId, credentialTable.id))
    .leftJoin(
      nurseUnitTable,
      and(eq(nurseUnitTable.nurseId, nurseTable.id), eq(nurseUnitTable.unitId, unitId)),
    )
    .where(
      and(
        eq(nurseTable.active, true),
        worksOnUnitBetween(unitId, earliest, onDate),
        isNotNull(nurseCredentialTable.expiresOn),
        gte(nurseCredentialTable.expiresOn, earliest),
        lt(nurseCredentialTable.expiresOn, onDate),
      ),
    )
    .orderBy(asc(nurseCredentialTable.expiresOn), asc(nurseTable.id))
    .all();
  return rows.map((r) => ({
    nurse: toNurse(r.nurse),
    credential: toCredential(r.credential),
    nurseCredential: toNurseCredential(r.nurseCredential),
  }));
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function listPreferencesForNurse(db: DbLike, nurseId: Id): Preference[] {
  return db
    .select()
    .from(preferenceTable)
    .where(eq(preferenceTable.nurseId, nurseId))
    .all()
    .map(toPreference);
}

/** Every preference across a unit in one query — fairness scoring needs all of them at once. */
export function listPreferencesForUnit(db: DbLike, unitId: Id): Preference[] {
  const rows = db
    .select({ preference: preferenceTable })
    .from(preferenceTable)
    .innerJoin(nurseTable, eq(preferenceTable.nurseId, nurseTable.id))
    .where(eq(nurseTable.unitId, unitId))
    .all();
  return rows.map((r) => toPreference(r.preference));
}

/**
 * Replace a nurse's whole preference set: delete then insert. Callers that need this atomic
 * alongside other profile changes should run it inside their own `transact()` — this function
 * only guarantees the delete and insert happen in the order shown, not that they are atomic
 * with anything else.
 */
export function replaceNursePreferences(
  db: DbLike,
  nurseId: Id,
  preferences: readonly Preference[],
  actor: string,
): Preference[] {
  // Checked before any write: a mismatched row would delete this nurse's set and insert another
  // nurse's, while the audit entry still named this one.
  if (preferences.some((p) => p.nurseId !== nurseId)) {
    throw new Error("A preference for another nurse cannot be saved in this nurse's set.");
  }
  const before = listPreferencesForNurse(db, nurseId);
  db.delete(preferenceTable).where(eq(preferenceTable.nurseId, nurseId)).run();
  if (preferences.length > 0) {
    db.insert(preferenceTable).values(preferences.map(fromPreference)).run();
  }
  recordAudit(db, {
    entityType: 'preference',
    entityId: nurseId,
    action: 'update',
    actor,
    before,
    after: preferences,
  });
  return preferences.slice();
}
