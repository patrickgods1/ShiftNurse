/**
 * Roster import/export: the persistence half of the CSV round-trip.
 *
 * `packages/core` turns text into validated rows and back; this module reconciles those rows
 * with what is already in the database. Import is an *upsert keyed on employee id* — a
 * manager re-importing last month's spreadsheet with three new hires must get three new
 * nurses and updated details for the rest, not 60 duplicates. Import never deactivates or
 * revokes anything: a nurse missing from the file may simply be on a different sheet, and
 * silently removing people from a schedule is the one thing an import must not do.
 */

import type { Credential, Id, IsoDate, NurseCredential, RosterCsvRow } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toCredential } from '../mappers.js';
import { credential as credentialTable } from '../schema.js';
import {
  createNurse,
  getNurseByEmployeeId,
  grantCredential,
  listCredentials,
  listNurseCredentials,
  listNursesForUnit,
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

export interface ImportSummary {
  created: number;
  updated: number;
  credentialsCreated: string[];
  credentialsGranted: number;
  credentialsUpdated: number;
}

/**
 * Upsert rows by employee id. Run inside `transact()`: a half-imported roster is worse than
 * a failed one.
 */
export function importRoster(
  db: DbLike,
  unitId: Id,
  rows: readonly RosterCsvRow[],
  actor: string,
): ImportSummary {
  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    credentialsCreated: [],
    credentialsGranted: 0,
    credentialsUpdated: 0,
  };
  const credentialByCode = new Map(listCredentials(db).map((c) => [c.code, c]));

  for (const row of rows) {
    const existing = getNurseByEmployeeId(db, unitId, row.nurse.employeeId);
    let nurseId: Id;
    if (existing) {
      updateNurse(
        db,
        existing.id,
        {
          ...row.nurse,
          // Blank in the sheet means "clear it" — the sheet is the source of truth on import.
          phone: row.nurse.phone ?? null,
          email: row.nurse.email ?? null,
          notes: row.nurse.notes ?? null,
          active: true,
        },
        actor,
      );
      nurseId = existing.id;
      summary.updated++;
    } else {
      nurseId = createNurse(db, { ...row.nurse, unitId, active: true }, actor).id;
      summary.created++;
    }

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
