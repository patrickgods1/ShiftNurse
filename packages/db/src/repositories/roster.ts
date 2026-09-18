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
} from '@shiftnurse/core';
import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm';
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
  preference as preferenceTable,
} from '../schema.js';

/** Drop keys the caller left `undefined`, so a partial patch only touches fields it sets. */
function compact<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function getNurseRowOrThrow(db: DbLike, id: Id): typeof nurseTable.$inferSelect {
  const row = db.select().from(nurseTable).where(eq(nurseTable.id, id)).get();
  if (!row) throw new Error(`Nurse ${id} not found`);
  return row;
}

function buildNurseRow(id: Id, input: Omit<Nurse, 'id'>): typeof nurseTable.$inferInsert {
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
  isChargeEligible?: boolean;
  isNovice?: boolean;
  isFloatEligible?: boolean;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean;
}

export function updateNurse(db: DbLike, id: Id, patch: NursePatch, actor: string): Nurse {
  const row = getNurseRowOrThrow(db, id);
  const before = toNurse(row);
  const merged = { ...row, ...compact(patch) };
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
 */
export function deactivateNurse(db: DbLike, id: Id, actor: string): Nurse {
  const row = getNurseRowOrThrow(db, id);
  const before = toNurse(row);
  const merged = { ...row, active: false };
  db.update(nurseTable).set(merged).where(eq(nurseTable.id, id)).run();
  const after = toNurse(merged);
  recordAudit(db, { entityType: 'nurse', entityId: id, action: 'delete', actor, before, after });
  return after;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function listCredentials(db: DbLike): Credential[] {
  return db.select().from(credentialTable).all().map(toCredential);
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

/** Nurse + credential pairs whose `expiresOn` falls inside `[start, end]`. Drives the compliance alert. */
export function credentialsExpiringBetween(
  db: DbLike,
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
    .where(
      and(
        isNotNull(nurseCredentialTable.expiresOn),
        gte(nurseCredentialTable.expiresOn, start),
        lte(nurseCredentialTable.expiresOn, end),
      ),
    )
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
