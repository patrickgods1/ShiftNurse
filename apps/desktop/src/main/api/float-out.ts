/**
 * Float rotation on the Today screen: when the unit has to send a nurse off a shift to help
 * another unit, rank who floats by the contract's order and float the first one with the order's
 * reason on the record.
 *
 * The ranking is core's `floatOrder`; this file loads what it needs (the shift's roster for one
 * role, the unit's float history over the last year, the preceptorships) and holds the one rule
 * the screen must never decide alone: only the nurse at the top of the order can be floated, so
 * the contract's order is what happened rather than what the manager clicked.
 */

import {
  type Assignment,
  addDays,
  floatOrder,
  type Id,
  type IsoDate,
  type Nurse,
} from '@shiftnurse/core';
import {
  createFloatRecord,
  type DbLike,
  deleteAssignment,
  getShiftType,
  listAssignmentsForPeriodOnDate,
  listFloatRecords,
  listPreceptorships,
  recordFloatObjection,
  rosterForPeriod,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import type {
  FloatOrderRequest,
  FloatOrderView,
  FloatPlaceView,
  ShiftNurseApi,
} from '../../shared/api.js';
import { ACTOR, periodOrThrow } from './context.js';
import { editSchedule } from './schedule.js';

/** The rotation counts a year of floats, as contracts do. */
const FLOAT_HISTORY_DAYS = 365;

const nameOf = (nurse: Nurse) => `${nurse.firstName} ${nurse.lastName}`;

export function floatOrderFor(db: DbLike, request: FloatOrderRequest): FloatOrderView {
  const { periodId, date, shiftTypeId, role, volunteers } = request;
  const period = periodOrThrow(db, periodId);
  const nurseById = new Map(rosterForPeriod(db, period).map((n) => [n.id, n]));
  const onShift: { nurse: Nurse; assignment: Assignment }[] = listAssignmentsForPeriodOnDate(
    db,
    periodId,
    date,
  )
    .filter((a) => a.shiftTypeId === shiftTypeId)
    .flatMap((assignment) => {
      const nurse = nurseById.get(assignment.nurseId);
      // Silently dropping the row would hide a nurse who is on the shift but could not be ranked.
      if (!nurse) {
        throw new Error(
          `Assignment ${assignment.id} is for nurse ${assignment.nurseId}, who is not on this period's roster`,
        );
      }
      return nurse.role === role ? [{ nurse, assignment }] : [];
    });
  const result = floatOrder({
    date,
    onShift: onShift.map(({ nurse, assignment }) => ({ nurse, isCharge: assignment.isCharge })),
    volunteers,
    preceptorships: listPreceptorships(db, period.unitId),
    history: listFloatRecords(db, period.unitId, addDays(date, -FLOAT_HISTORY_DAYS)),
  });
  const entryOf = (id: Id) => onShift.find((e) => e.nurse.id === id)!;
  return {
    periodId,
    date,
    shiftTypeId,
    role,
    order: result.order.map((p) => ({
      nurseId: p.nurseId,
      assignmentId: entryOf(p.nurseId).assignment.id,
      name: nameOf(entryOf(p.nurseId).nurse),
      rank: p.rank,
      basis: p.basis,
      reason: p.reason,
    })),
    excluded: result.excluded.map((e) => ({
      nurseId: e.nurseId,
      name: nameOf(entryOf(e.nurseId).nurse),
      reason: e.reason,
    })),
  };
}

/** The place `nurseId` holds, or the refusal a manager can act on. */
function nextInOrder(view: FloatOrderView, nurseId: Id): FloatPlaceView {
  const excluded = view.excluded.find((e) => e.nurseId === nurseId);
  if (excluded) throw new Error(`${excluded.name}: ${excluded.reason}.`);
  const first = view.order[0];
  const mine = view.order.find((p) => p.nurseId === nurseId);
  if (!mine) throw new Error('That nurse is not on this shift.');
  if (first && first.nurseId !== nurseId) {
    throw new Error(
      `${first.name} floats before ${mine.name}. ${first.reason}. Float ${first.name} first.`,
    );
  }
  return mine;
}

export function floatOutApi(db: ShiftNurseDb): ShiftNurseApi['floatOut'] {
  return {
    order: (request) => floatOrderFor(db, request),
    send: (input) => {
      const { periodId, date, shiftTypeId, nurseId, reason } = input;
      const request: FloatOrderRequest = {
        periodId,
        date,
        shiftTypeId,
        role: input.role,
        volunteers: input.volunteers,
      };
      if (!getShiftType(db, shiftTypeId)) throw new Error(`Unknown shift type ${shiftTypeId}`);
      return editSchedule(db, periodId, reason, 'float', (tx, log) => {
        // Ranked inside the transaction, so what is acted on is what is recorded.
        const place = nextInOrder(floatOrderFor(tx, request), nurseId);
        const assignment = listAssignmentsForPeriodOnDate(tx, periodId, date).find(
          (a) => a.id === place.assignmentId,
        );
        if (!assignment) throw new Error('That nurse is no longer on this shift.');
        const record = createFloatRecord(
          tx,
          {
            unitId: periodOrThrow(tx, periodId).unitId,
            nurseId,
            date,
            shiftTypeId,
            toUnit: input.toUnit,
            volunteered: input.volunteers.includes(nurseId),
            ...(input.objection ? { objection: input.objection } : {}),
          },
          ACTOR,
        );
        deleteAssignment(tx, assignment.id, ACTOR, reason);
        log({ kind: 'removed', assignment, before: assignment });
        return record;
      });
    },
    history: (unitId: Id, since: IsoDate) => listFloatRecords(db, unitId, since),
    recordObjection: (id, objection) =>
      transact(db, (tx) => recordFloatObjection(tx, id, objection, ACTOR)),
  };
}
