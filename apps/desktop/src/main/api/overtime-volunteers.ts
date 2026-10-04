import {
  createOvertimeVolunteer,
  deleteOvertimeVolunteer,
  listOvertimeVolunteers,
  type ShiftNurseDb,
  transact,
  updateOvertimeVolunteer,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

export function overtimeVolunteersApi(db: ShiftNurseDb): ShiftNurseApi['overtimeVolunteers'] {
  return {
    list: (unitId) => listOvertimeVolunteers(db, unitId),
    create: (input) => transact(db, (tx) => createOvertimeVolunteer(tx, input, ACTOR)),
    update: (id, patch) => transact(db, (tx) => updateOvertimeVolunteer(tx, id, patch, ACTOR)),
    remove: (id) => transact(db, (tx) => deleteOvertimeVolunteer(tx, id, ACTOR)),
  };
}
