/**
 * Roster import/export: the persistence half of the CSV round-trip.
 *
 * `packages/core` turns text into validated rows and back; this module reconciles those rows
 * with what is already in the database. Import is an *upsert keyed on employee id* — a
 * manager re-importing last month's spreadsheet with three new hires must get three new
 * nurses and updated details for the rest, not 60 duplicates. Import never deactivates or
 * revokes anything: a nurse missing from the file may simply be on a different sheet, and
 * silently removing people from a schedule is the one thing an import must not do. The same goes
 * the other way: it reactivates a departed nurse only when the manager asks, and a column the
 * file does not carry is left as it is (core's `rosterChangesFor` decides, as the preview does).
 */

import {
  type Credential,
  type Id,
  type IsoDate,
  matchStoredNurse,
  type NurseCredential,
  type RosterColumn,
  type RosterCsvRow,
  rosterChangesFor,
} from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toCredential } from '../mappers.js';
import { credential as credentialTable } from '../schema.js';
import {
  createNurse,
  getNurse,
  grantCredential,
  listCredentials,
  listNurseCredentials,
  listNursesForUnit,
  type NursePatch,
  updateCredentialExpiry,
  updateNurse,
} from './roster.js';

export function getCredentialByCode(db: DbLike, code: string): Credential | undefined {
  const row = db.select().from(credentialTable).where(eq(credentialTable.code, code)).get();
  return row ? toCredential(row) : undefined;
}

export function createCredential(
  db: DbLike,
  input: Omit<Credential, 'id'>,
  actor: string,
): Credential {
  const id = ids.credential();
  const row: typeof credentialTable.$inferInsert = { id, ...input };
  db.insert(credentialTable).values(row).run();
  const after = toCredential(row as typeof credentialTable.$inferSelect);
  recordAudit(db, { entityType: 'credential', entityId: id, action: 'create', actor, after });
  return after;
}

export interface GrantNewCredentialInput {
  nurseId: Id;
  code: string;
  name: string;
  tracksExpiry: boolean;
  expiresOn?: IsoDate;
}

/**
 * Creates a credential type and grants it to one nurse: both rows, or neither. Two calls left an
 * ungranted type behind when the grant failed, and that type then blocked the retry on the
 * UNIQUE code.
 */
export function grantNewCredential(
  tx: ShiftNurseTx,
  input: GrantNewCredentialInput,
  actor: string,
): { credential: Credential; nurseCredential: NurseCredential } {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!code) throw new Error('Enter a code for the credential, such as ACLS.');
  if (!name) throw new Error("Enter the credential's name.");
  if (!getNurse(tx, input.nurseId)) throw new Error('That nurse was not found. Reload the page.');
  const existing = getCredentialByCode(tx, code);
  if (existing) {
    throw new Error(
      `There is already a credential with code ${code} (${existing.name}); choose it from the list instead.`,
    );
  }
  if (!input.tracksExpiry && input.expiresOn !== undefined) {
    throw new Error(`${code} does not track expiry; leave the expiry date empty.`);
  }
  const credential = createCredential(tx, { code, name, tracksExpiry: input.tracksExpiry }, actor);
  const nurseCredential = grantCredential(
    tx,
    { nurseId: input.nurseId, credentialId: credential.id, expiresOn: input.expiresOn },
    actor,
  );
  return { credential, nurseCredential };
}

/** Every active nurse on the unit as CSV rows, credentials by code. */
export function exportRoster(db: DbLike, unitId: Id): RosterCsvRow[] {
  const codeById = new Map(listCredentials(db).map((c) => [c.id, c.code]));
  return listNursesForUnit(db, unitId)
    .filter((n) => n.active)
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))
    .map((n) => {
      const { id: _id, unitId: _unit, active: _active, ...fields } = n;
      const credentials = listNurseCredentials(db, n.id)
        .map((nc) => ({ code: codeById.get(nc.credentialId) ?? '?', expiresOn: nc.expiresOn }))
        .sort((a, b) => a.code.localeCompare(b.code));
      return { nurse: fields, credentials };
    });
}

export interface RosterImportOptions {
  /** The columns the file carried (`RosterCsvResult.columns`). */
  columns: readonly RosterColumn[];
  /** Reactivate matched nurses who are inactive. Off: they are updated and stay inactive. */
  reactivate: boolean;
}

export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  /** "Cruz, Ana" for each nurse brought back. */
  reactivated: string[];
  /** Matched inactive nurses left inactive. */
  keptInactive: string[];
  credentialsCreated: string[];
  credentialsGranted: number;
  credentialsUpdated: number;
}

/**
 * Upsert rows by employee id. Run inside `transact()`: a half-imported roster is worse than
 * a failed one.
 */
export function importRoster(
  // A transaction, not any handle: these writes are only correct all-or-nothing.
  db: ShiftNurseTx,
  unitId: Id,
  rows: readonly RosterCsvRow[],
  options: RosterImportOptions,
  actor: string,
): ImportSummary {
  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    reactivated: [],
    keptInactive: [],
    credentialsCreated: [],
    credentialsGranted: 0,
    credentialsUpdated: 0,
  };
  const credentialByCode = new Map(listCredentials(db).map((c) => [c.code, c]));

  // Inactive nurses included: a departed nurse's row must find her, not create a twin. Matching
  // is case-insensitive (core's matcher, the one the preview uses); the stored spelling is kept.
  const stored = [...listNursesForUnit(db, unitId)];
  for (const row of rows) {
    const found = matchStoredNurse(stored, row.nurse.employeeId);
    if (found.kind !== 'ambiguous') continue;
    throw new Error(
      `Employee id "${row.nurse.employeeId}" matches two nurses on this unit: ${found.nurses
        .map((n) => `${n.lastName}, ${n.firstName} ("${n.employeeId}")`)
        .join(' and ')}. Give one of them a different employee id under Roster, then import again.`,
    );
  }

  for (const row of rows) {
    const found = matchStoredNurse(stored, row.nurse.employeeId);
    const existing = found.kind === 'one' ? found.nurse : undefined;
    let nurseId: Id;
    if (existing) {
      const reactivating = options.reactivate && !existing.active;
      const patch: NursePatch = {
        ...rosterChangesFor(existing, row, options.columns),
        ...(reactivating ? { active: true } : {}),
      };
      const listName = `${row.nurse.lastName}, ${row.nurse.firstName}`;
      if (Object.keys(patch).length > 0) {
        updateNurse(db, existing.id, patch, actor);
        summary.updated++;
      } else {
        summary.unchanged++;
      }
      if (reactivating) summary.reactivated.push(listName);
      else if (!existing.active) summary.keptInactive.push(listName);
      nurseId = existing.id;
    } else {
      const created = createNurse(db, { ...row.nurse, unitId, active: true }, actor);
      stored.push(created);
      nurseId = created.id;
      summary.created++;
    }

    if (!options.columns.includes('credentials')) continue;
    const held = new Map<Id, NurseCredential>(
      listNurseCredentials(db, nurseId).map((nc) => [nc.credentialId, nc]),
    );
    for (const c of row.credentials) {
      let credential = credentialByCode.get(c.code);
      if (!credential) {
        credential = createCredential(
          db,
          { code: c.code, name: c.code, tracksExpiry: c.expiresOn !== undefined },
          actor,
        );
        credentialByCode.set(c.code, credential);
        summary.credentialsCreated.push(c.code);
      }
      const current = held.get(credential.id);
      if (!current) {
        grantCredential(
          db,
          { nurseId, credentialId: credential.id, expiresOn: c.expiresOn as IsoDate | undefined },
          actor,
        );
        summary.credentialsGranted++;
      } else if (current.expiresOn !== c.expiresOn) {
        updateCredentialExpiry(db, current.id, c.expiresOn, actor);
        summary.credentialsUpdated++;
      }
    }
  }
  return summary;
}
