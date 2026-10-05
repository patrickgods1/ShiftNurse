import {
  createDayOfPayEvent,
  deleteDayOfPayEvent,
  listDayOfPayEvents,
  type ShiftNurseDb,
  transact,
  updateDayOfPayEvent,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

/** Events paid outside the schedule; each write is one transaction with its audit row. */
export function dayOfPayApi(db: ShiftNurseDb): ShiftNurseApi['dayOfPay'] {
  return {
    list: (unitId, start, end) => listDayOfPayEvents(db, unitId, start, end),
    record: (entry) => transact(db, (tx) => createDayOfPayEvent(tx, entry, ACTOR)),
    update: (id, patch) => transact(db, (tx) => updateDayOfPayEvent(tx, id, patch, ACTOR)),
    remove: (id) => transact(db, (tx) => deleteDayOfPayEvent(tx, id, ACTOR)),
  };
}
