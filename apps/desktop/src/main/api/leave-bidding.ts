/**
 * Leave bidding through IPC. Every write is one `transact`; the award in particular is the
 * repository's all-or-nothing `awardRound`, with nurse names added here because the renderer is
 * shown a result table, not ids.
 */

import {
  awardRound,
  closeLeaveBidRound,
  createLeaveBidRound,
  listLeaveBidRounds,
  listLeaveBids,
  listNursesForUnit,
  type ShiftNurseDb,
  submitLeaveBid,
  transact,
  updateLeaveBidRound,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

export function leaveBiddingApi(db: ShiftNurseDb): ShiftNurseApi['leaveBidding'] {
  return {
    rounds: (unitId) => listLeaveBidRounds(db, unitId),
    createRound: (input) => transact(db, (tx) => createLeaveBidRound(tx, input, ACTOR)),
    updateRound: (id, patch) => transact(db, (tx) => updateLeaveBidRound(tx, id, patch, ACTOR)),
    closeRound: (id) => transact(db, (tx) => closeLeaveBidRound(tx, id, ACTOR)),
    bids: (roundId) => listLeaveBids(db, roundId),
    submitBid: (roundId, nurseId, choices) =>
      transact(db, (tx) => submitLeaveBid(tx, roundId, nurseId, choices, ACTOR)),
    award: (roundId) =>
      transact(db, (tx) => {
        const { round, result, awarded } = awardRound(tx, roundId, ACTOR);
        const names = new Map(
          listNursesForUnit(tx, round.unitId).map((n) => [n.id, `${n.firstName} ${n.lastName}`]),
        );
        const nameOf = (id: string) => names.get(id) ?? id;
        return {
          round,
          order: result.order.map((nurseId) => ({ nurseId, nurseName: nameOf(nurseId) })),
          awards: awarded.map((a) => ({
            ...a.award,
            nurseName: nameOf(a.award.nurseId),
            requestId: a.request.id,
            liftedShifts: a.lifted.length,
            stillRostered: a.stillRostered.length,
          })),
          denials: result.denials.map((d) => ({ ...d, nurseName: nameOf(d.nurseId) })),
        };
      }),
  };
}
