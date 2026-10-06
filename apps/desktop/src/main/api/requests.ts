/**
 * The Requests page's resources: time off, conflicts and shift exchanges. Decisions are audited
 * with the manager's reason, in the same transaction as the decision itself.
 */

import {
  evaluateExchange,
  type HolidayClaim,
  holidayRequestPriority,
  type Id,
  previousOccurrence,
  timeOffImpact,
} from '@shiftnurse/core';
import {
  applyResolution,
  approveTimeOffAndLiftAssignments,
  cancelSwap,
  cancelTimeOff,
  createTimeOffRequest,
  denySwap,
  denyTimeOff,
  getConflictPolicy,
  holidayWorkFor,
  listHolidaysForUnit,
  listNursesForUnit,
  listSwapsForPeriod,
  listSwapsForUnit,
  listTimeOffForUnit,
  listTimeOffOverlappingForUnit,
  proposeSwap,
  type ShiftNurseDb,
  saveConflictPolicy,
  transact,
  withdrawApproval,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { analyse, approveExchange, autoResolve } from './conflicts.js';
import { ACTOR, buildConflictInput } from './context.js';
import { approveAndCover, coverOptions } from './leave.js';

/**
 * Pending requests that cover a holiday, ranked by the contract's order. Read-only: the ranking
 * is advice, so nothing is written or audited. Work is loaded for last year's occurrences only,
 * the one set of records the ranking reads.
 */
function holidayPriority(db: ShiftNurseDb, unitId: Id): HolidayClaim[] {
  const holidays = listHolidaysForUnit(db, unitId);
  const previousIds = holidays.flatMap((h) => previousOccurrence(h, holidays)?.id ?? []);
  return holidayRequestPriority({
    pending: listTimeOffForUnit(db, unitId, 'pending'),
    approved: listTimeOffForUnit(db, unitId, 'approved'),
    nurses: listNursesForUnit(db, unitId),
    holidays,
    holidayWork: holidayWorkFor(db, unitId, previousIds),
  });
}

export function requestsApi(
  db: ShiftNurseDb,
): Pick<ShiftNurseApi, 'timeOff' | 'conflicts' | 'exchange'> {
  return {
    timeOff: {
      list: (unitId, status) => listTimeOffForUnit(db, unitId, status),
      holidayPriority: (unitId) => holidayPriority(db, unitId),
      listInRange: (unitId, start, end) => listTimeOffOverlappingForUnit(db, unitId, start, end),
      create: (input) => transact(db, (tx) => createTimeOffRequest(tx, input, ACTOR)),
      approve: (id, reason) =>
        transact(db, (tx) => approveTimeOffAndLiftAssignments(tx, id, ACTOR, reason)),
      deny: (id, reason) => transact(db, (tx) => denyTimeOff(tx, id, ACTOR, reason)),
      cancel: (id, reason) => transact(db, (tx) => cancelTimeOff(tx, id, ACTOR, reason)),
      withdrawApproval: (id, reason) =>
        transact(db, (tx) => withdrawApproval(tx, id, ACTOR, reason)),
      impact: (periodId, requestId, decision) =>
        timeOffImpact(buildConflictInput(db, periodId), requestId, decision),
      coverOptions: (periodId, requestId) => coverOptions(db, periodId, requestId),
      approveAndCover: (periodId, requestId, reason, covers) => {
        approveAndCover(db, periodId, requestId, reason, covers);
      },
    },
    conflicts: {
      analyse: (periodId) => analyse(db, periodId),
      policy: (unitId) => getConflictPolicy(db, unitId),
      savePolicy: (unitId, policy) =>
        transact(db, (tx) => saveConflictPolicy(tx, unitId, policy, ACTOR)),
      resolve: (periodId, resolution, reason) =>
        transact(
          db,
          (tx) =>
            applyResolution(tx, periodId, resolution, ACTOR, { auto: false, reason }).resolution,
        ),
      autoResolve: (periodId) => autoResolve(db, periodId),
    },
    exchange: {
      list: (unitId, status) => listSwapsForUnit(db, unitId, status),
      listForPeriod: (periodId, status) => listSwapsForPeriod(db, periodId, status),
      evaluate: (periodId, proposal) =>
        evaluateExchange({ ...buildConflictInput(db, periodId), proposal }),
      propose: (periodId, proposal, reason) =>
        transact(db, (tx) => proposeSwap(tx, { ...proposal, periodId, reason }, ACTOR)),
      approve: (id, reason) => approveExchange(db, id, reason),
      deny: (id, reason) => transact(db, (tx) => denySwap(tx, id, ACTOR, reason)),
      cancel: (id, reason) => transact(db, (tx) => cancelSwap(tx, id, ACTOR, reason)),
    },
  };
}
