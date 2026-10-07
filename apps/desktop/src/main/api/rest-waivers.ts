import {
  createRestWaiver,
  deleteRestWaiver,
  listRestWaivers,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

export function restWaiversApi(db: ShiftNurseDb): ShiftNurseApi['restWaivers'] {
  return {
    list: (unitId) => listRestWaivers(db, unitId),
    create: (input) => transact(db, (tx) => createRestWaiver(tx, input, ACTOR)),
    remove: (id, reason) => transact(db, (tx) => deleteRestWaiver(tx, id, reason, ACTOR)),
  };
}
