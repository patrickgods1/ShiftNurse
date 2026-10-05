import type { Nurse } from '@shiftnurse/core';
import {
  createNurseUnit,
  deleteNurseUnit,
  getNurse,
  listNurseUnitsForNurse,
  listNurseUnitsForUnit,
  rosterForPeriod,
  type ShiftNurseDb,
  transact,
  updateNurseUnit,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR, periodOrThrow } from './context.js';

export function nurseUnitsApi(db: ShiftNurseDb): ShiftNurseApi['nurseUnits'] {
  return {
    forNurse: (nurseId) => listNurseUnitsForNurse(db, nurseId),
    // Everyone with a membership here, whatever its dates: the grid needs a name for any shift
    // already written, and a membership that has since lapsed still has them.
    floatingIn: (unitId) =>
      listNurseUnitsForUnit(db, unitId).flatMap((m): Nurse[] => {
        const nurse = getNurse(db, m.nurseId);
        return nurse && nurse.unitId !== unitId ? [nurse] : [];
      }),
    // The one definition validation and Generate read, so the grid offers exactly those rows.
    roster: (periodId) => rosterForPeriod(db, periodOrThrow(db, periodId)),
    create: (input) => transact(db, (tx) => createNurseUnit(tx, input, ACTOR)),
    update: (id, patch) => transact(db, (tx) => updateNurseUnit(tx, id, patch, ACTOR)),
    remove: (id) => transact(db, (tx) => deleteNurseUnit(tx, id, ACTOR)),
  };
}
