/**
 * The roster resources: nurses, credentials, preferences, nurses kept apart, and the roster
 * CSV. Every write runs in one transaction with its audit row, so a change can never commit
 * without the record of it (see `audit.ts`).
 */

import { formatRosterCsv, type Preference } from '@shiftnurse/core';
import {
  createCredential,
  createIncompatibilityGroup,
  createNurse,
  deactivateNurse,
  deleteIncompatibilityGroup,
  exportRoster,
  getNurse,
  grantCredential,
  ids,
  importRoster,
  listCredentials,
  listIncompatibilityGroups,
  listNurseCredentials,
  listNursesForUnit,
  listPreferencesForNurse,
  replaceNursePreferences,
  revokeCredential,
  type ShiftNurseDb,
  transact,
  updateCredentialExpiry,
  updateIncompatibilityGroup,
  updateNurse,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

export function rosterApi(db: ShiftNurseDb): Pick<
  ShiftNurseApi,
  'nurses' | 'credentials' | 'preferences' | 'incompatibility'
> & {
  roster: Omit<ShiftNurseApi['roster'], 'pickImportFile' | 'exportToFile'>;
} {
  return {
    nurses: {
      list: (unitId) => listNursesForUnit(db, unitId),
      get: (id) => getNurse(db, id),
      create: (input) => transact(db, (tx) => createNurse(tx, input, ACTOR)),
      update: (id, patch) => transact(db, (tx) => updateNurse(tx, id, patch, ACTOR)),
      deactivate: (id) => transact(db, (tx) => deactivateNurse(tx, id, ACTOR)),
    },
    credentials: {
      list: () => listCredentials(db),
      create: (input) => transact(db, (tx) => createCredential(tx, input, ACTOR)),
      forNurse: (nurseId) => listNurseCredentials(db, nurseId),
      grant: (input) => transact(db, (tx) => grantCredential(tx, input, ACTOR)),
      updateExpiry: (id, expiresOn) =>
        transact(db, (tx) => updateCredentialExpiry(tx, id, expiresOn, ACTOR)),
      revoke: (id) => transact(db, (tx) => revokeCredential(tx, id, ACTOR)),
    },
    preferences: {
      forNurse: (nurseId) => listPreferencesForNurse(db, nurseId),
      replace: (nurseId, inputs) =>
        transact(db, (tx) =>
          replaceNursePreferences(
            tx,
            nurseId,
            inputs.map((p) => ({ ...p, id: ids.preference(), nurseId }) as Preference),
            ACTOR,
          ),
        ),
    },
    incompatibility: {
      list: (unitId) => listIncompatibilityGroups(db, unitId),
      create: (input, reason) =>
        transact(db, (tx) => createIncompatibilityGroup(tx, input, reason, ACTOR)),
      update: (id, patch, reason) =>
        transact(db, (tx) => updateIncompatibilityGroup(tx, id, patch, reason, ACTOR)),
      remove: (id, reason) =>
        transact(db, (tx) => deleteIncompatibilityGroup(tx, id, reason, ACTOR)),
    },
    // The file-dialog halves (`pickImportFile`, `exportToFile`) are Electron's; `api.ts` adds them.
    roster: {
      importRows: (unitId, rows) => transact(db, (tx) => importRoster(tx, unitId, rows, ACTOR)),
      exportCsv: (unitId) => formatRosterCsv(exportRoster(db, unitId)),
    },
  };
}
