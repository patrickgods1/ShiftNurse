import {
  createAvailabilityBlock,
  deleteAvailabilityBlock,
  listAvailabilityBlocks,
  type ShiftNurseDb,
  transact,
  updateAvailabilityBlock,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

export function availabilityBlocksApi(db: ShiftNurseDb): ShiftNurseApi['availabilityBlocks'] {
  return {
    list: (unitId) => listAvailabilityBlocks(db, unitId),
    create: (input) => transact(db, (tx) => createAvailabilityBlock(tx, input, ACTOR)),
    update: (id, patch, reason) =>
      transact(db, (tx) => updateAvailabilityBlock(tx, id, { ...patch, reason }, ACTOR)),
    remove: (id, reason) => transact(db, (tx) => deleteAvailabilityBlock(tx, id, reason, ACTOR)),
  };
}
