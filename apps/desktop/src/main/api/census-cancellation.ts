/**
 * Low-census cancellation on the Today screen: when a shift has more nurses than its patients
 * need, rank who goes home by the unit's own order, and send the next one home with the order's
 * reason on the record.
 *
 * The ranking is core's `cancellationOrder`; this file loads what it needs (the shift's roster
 * for one role, the unit's tier order, each nurse's cancellations over the last year) and holds
 * the one rule the screen must never decide alone: only the nurse at the top of the order can be
 * cancelled, so the contract's order is what happened rather than what the manager clicked.
 */

import {
  type Assignment,
  cancellationOrder,
  checkStaffing,
  type Id,
  type IsoDate,
  type Nurse,
  type NurseRole,
  type RoleStaffing,
  type ShiftStaffingCheck,
} from '@shiftnurse/core';
import {
  cancellationHistory,
  createDayOfPayEvent,
  type DbLike,
  deleteAssignment,
  demandInputs,
  getCancellationPolicy,
  getShiftType,
  listAssignmentsForPeriodOnDate,
  listShiftTypesForUnit,
  recordShiftCancellation,
  rosterForPeriod,
  type ShiftNurseDb,
} from '@shiftnurse/db';
import type {
  CancellationOrderView,
  CancellationPlaceView,
  OverstaffedRole,
  ShiftCancellationRecord,
} from '../../shared/api.js';
import { ACTOR, periodOrThrow } from './context.js';
import { editSchedule } from './schedule.js';

const nameOf = (nurse: Nurse) => `${nurse.firstName} ${nurse.lastName}`;

/**
 * Roles with more nurses than the shift needs. A role the shift does not require at all (an LPN
 * on an RN-and-CNA unit) is not "over": nobody asked for one. Under a licensed ratio an RN or LPN above their
 * own minimum may still be one the RN + LPN pool needs, so for those two roles the spare is
 * capped at the pool's slack: three RNs and an LVN against "four licensed, two RNs" spare nobody,
 * though the third RN is above the RN minimum.
 */
export function overstaffedRoles(periodId: Id, staffing: ShiftStaffingCheck): OverstaffedRole[] {
  const pool = staffing.licensed;
  // The pool's spare is shared, not each role's: offered to LPNs first, keeping RNs, who can
  // fill any licensed place, then to RNs with what is left.
  let poolSlack = pool ? Math.max(0, pool.staffed - pool.required) : undefined;
  const excessOf = (r: RoleStaffing): number => {
    const pooled = poolSlack !== undefined && (r.role === 'RN' || r.role === 'LPN');
    // A role nobody asked for is not overstaffed — unless the pool asks for it.
    if (r.required <= 0 && !pooled) return 0;
    const own = r.staffed - r.required;
    if (!pooled) return own;
    const excess = Math.max(0, Math.min(own, poolSlack!));
    poolSlack! -= excess;
    return excess;
  };
  const roles = Object.values(staffing.byRole) as RoleStaffing[];
  const order = [...roles].sort((a, b) => (a.role === 'LPN' ? -1 : b.role === 'LPN' ? 1 : 0));
  const excess = new Map(order.map((r) => [r.role, excessOf(r)]));
  return roles.flatMap((r) => {
    const e = excess.get(r.role)!;
    return e > 0
      ? [{ periodId, role: r.role, required: r.required, staffed: r.staffed, excess: e }]
      : [];
  });
}

export function cancellationOrderFor(
  db: DbLike,
  periodId: Id,
  date: IsoDate,
  shiftTypeId: Id,
  role: NurseRole,
  volunteers: readonly Id[],
): CancellationOrderView {
  const period = periodOrThrow(db, periodId);
  const nurses = rosterForPeriod(db, period);
  const nurseById = new Map(nurses.map((n) => [n.id, n]));
  const onDate: Assignment[] = listAssignmentsForPeriodOnDate(db, periodId, date);
  const check = checkStaffing({
    date,
    shiftTypes: listShiftTypesForUnit(db, period.unitId),
    nurses,
    assignments: onDate,
    demand: demandInputs(db, period.unitId, date, date),
  }).find((c) => c.shiftTypeId === shiftTypeId);
  if (!check) throw new Error('That shift is not one of this unit’s active shifts');
  const { required, staffed } = check.byRole[role];

  const onShift = onDate
    .filter((a) => a.shiftTypeId === shiftTypeId)
    .flatMap((assignment) => {
      const nurse = nurseById.get(assignment.nurseId);
      return nurse?.role === role ? [{ nurse, assignment }] : [];
    });
  const result = cancellationOrder({
    onShift,
    tiers: getCancellationPolicy(db, period.unitId),
    volunteers,
    history: cancellationHistory(db, period.unitId, date),
  });
  const name = (id: Id) => nameOf(nurseById.get(id) as Nurse);
  return {
    periodId,
    date,
    shiftTypeId,
    role,
    required,
    staffed,
    // The one definition, pool included, so the refusal below agrees with the panel.
    excess: overstaffedRoles(periodId, check).find((r) => r.role === role)?.excess ?? 0,
    order: result.order.map((p) => ({
      nurseId: p.nurseId,
      assignmentId: p.assignmentId,
      name: name(p.nurseId),
      tier: p.tier,
      reason: p.reason,
    })),
    excluded: result.excluded.map((e) => ({
      nurseId: e.nurseId,
      name: name(e.nurseId),
      reason: e.reason,
    })),
  };
}

/** The place `nurseId` holds, or the refusal a manager can act on. */
function nextInOrder(view: CancellationOrderView, nurseId: Id): CancellationPlaceView {
  if (view.excess <= 0) {
    throw new Error(
      'This shift is no longer over its requirement, so nobody needs to be sent home.',
    );
  }
  const excluded = view.excluded.find((e) => e.nurseId === nurseId);
  if (excluded) throw new Error(excluded.reason);
  const first = view.order[0];
  const mine = view.order.find((p) => p.nurseId === nurseId);
  if (!mine) throw new Error('That nurse is not on this shift.');
  if (first && first.nurseId !== nurseId) {
    throw new Error(
      `${first.name} goes home before ${mine.name}. ${first.reason} Cancel ${first.name} first.`,
    );
  }
  return mine;
}

export function cancelForCensus(
  db: ShiftNurseDb,
  periodId: Id,
  date: IsoDate,
  shiftTypeId: Id,
  role: NurseRole,
  volunteers: readonly Id[],
  nurseId: Id,
): ShiftCancellationRecord {
  const shiftType = getShiftType(db, shiftTypeId);
  if (!shiftType) throw new Error(`Unknown shift type ${shiftTypeId}`);
  // The change-log reason is needed before the transaction opens (a published period refuses an
  // edit without one), so rank once to word it; the ranking is repeated inside to act on.
  const place = nextInOrder(
    cancellationOrderFor(db, periodId, date, shiftTypeId, role, volunteers),
    nurseId,
  );
  const reason = `Low census: ${place.name}, ${date} ${shiftType.abbreviation} — ${place.reason}`;

  return editSchedule(db, periodId, reason, 'census', (tx, log) => {
    const current = nextInOrder(
      cancellationOrderFor(tx, periodId, date, shiftTypeId, role, volunteers),
      nurseId,
    );
    const assignment = listAssignmentsForPeriodOnDate(tx, periodId, date).find(
      (a) => a.id === current.assignmentId,
    );
    if (!assignment) throw new Error('That nurse is no longer on this shift.');
    const record = recordShiftCancellation(
      tx,
      { periodId, nurseId, shiftTypeId, date, reason: current.reason },
      ACTOR,
    );
    // Sent home on arrival is paid reporting time (half the shift, 2-4 hours) whether or not the
    // schedule shows the shift any more, so the pay event is written with the cancellation, never
    // later. Hours worked start at 0; the manager edits them if the nurse stayed a while.
    createDayOfPayEvent(
      tx,
      {
        kind: 'sent_home',
        unitId: periodOrThrow(tx, periodId).unitId,
        nurseId,
        date,
        shiftTypeId,
        scheduledHours: shiftType.durationHours,
        hoursWorked: 0,
        note: 'Low-census cancellation',
      },
      ACTOR,
    );
    deleteAssignment(tx, assignment.id, ACTOR, reason);
    log({ kind: 'removed', assignment, before: assignment });
    return record;
  });
}
