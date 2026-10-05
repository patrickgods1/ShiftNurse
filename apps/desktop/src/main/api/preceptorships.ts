import {
  createPreceptorship,
  deletePreceptorship,
  listPreceptorships,
  type ShiftNurseDb,
  transact,
  updatePreceptorship,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

export function preceptorshipsApi(db: ShiftNurseDb): ShiftNurseApi['preceptorships'] {
  return {
    list: (unitId) => listPreceptorships(db, unitId),
    // One record per preceptor in one transaction: a second preceptor refused (from another
    // unit, say) must not leave the first recorded as if the manager's whole entry had held.
    create: ({ preceptorIds, ...rest }) =>
      transact(db, (tx) =>
        [...new Set(preceptorIds)].map((preceptorId) =>
          createPreceptorship(tx, { ...rest, preceptorId }, ACTOR),
        ),
      ),
    update: (id, patch) => transact(db, (tx) => updatePreceptorship(tx, id, patch, ACTOR)),
    remove: (id) => transact(db, (tx) => deletePreceptorship(tx, id, ACTOR)),
  };
}
