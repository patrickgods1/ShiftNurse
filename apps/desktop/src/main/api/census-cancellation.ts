/**
 * Low-census cancellation on the Today screen: when a shift has more nurses than its patients
 * need, rank who goes home by the unit's own order, and send the next one home with the order's
 * reason on the record.
 *
 * The ranking is core's `cancellationOrder`; this file loads what it needs (the shift's roster
 * for one role, the unit's tier order, each nurse's cancellations over the last year) and holds
 * the one rule the screen must never decide alone: only the nurse at the top of the order can be
 * cancelled, so the contract's order is what happened rather than what the manager clicked —
 * and leaves out anyone whose removal would break a hard rule, so the next safe nurse is first.
 */

import {
  type Assignment,
  cancellationOrder,
  checkStaffing,
  describeDate,
  type Id,
  type IsoDate,
  isFloatedOff,
  type Nurse,
  type NurseRole,
  type RoleStaffing,
  removalBreaks,
  reportingPayOwed,
  type ShiftStaffingCheck,
  shiftWindow,
  today,
} from '@shiftnurse/core';
import {
  cancellationHistory,
  createDayOfPayEvent,
  type DbLike,
  deleteAssignment,
  demandInputs,
  demandInputsForDate,
  getCancellationPolicy,
  getPaySettings,
  getShiftType,
  listAssignmentsForPeriodOnDate,
  recordShiftCancellation,
  rosterForPeriod,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import type {
  CancellationOrderView,
  CancellationPlaceView,
  OverstaffedRole,
  ShiftCancellationRecord,
} from '../../shared/api.js';
import { hostWallMinute } from './clock.js';
import { ACTOR, buildConflictInput, periodOrThrow } from './context.js';
import { firstInOrder, nurseName } from './order.js';
import { openChangeLog } from './schedule.js';

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
  // What the shift needed under the demand rules in force that day, as the grid judges it.
  const demand = demandInputsForDate(db, period, date, {
    today: today(),
    live: demandInputs(db, period.unitId, date, date),
  });
  const check = checkStaffing({
    date,
    shiftTypes: demand.shiftTypes,
    nurses,
    assignments: onDate,
    demand,
  }).find((c) => c.shiftTypeId === shiftTypeId);
  if (!check) {
    const type = demand.shiftTypes.find((t) => t.id === shiftTypeId);
    // A type retired since, or created after the date, was no shift that day: there was nothing
    // to staff, so nothing to cancel.
    throw new Error(
      type
        ? `${type.name} was not an active shift on ${describeDate(date)}.`
        : 'That shift is not one of this unit’s shifts.',
    );
  }
  const { required, staffed } = check.byRole[role];

  const onShift = onDate
    // Already sent to another unit: there is nothing here to cancel.
    .filter((a) => a.shiftTypeId === shiftTypeId && !isFloatedOff(a))
    .flatMap((assignment) => {
      const nurse = nurseById.get(assignment.nurseId);
      return nurse?.role === role ? [{ nurse, assignment }] : [];
    });
  const result = cancellationOrder({
    unitId: period.unitId,
    onShift,
    tiers: getCancellationPolicy(db, period.unitId),
    volunteers,
    history: cancellationHistory(db, period.unitId, date),
    // Judged on `db`, which inside `cancelForCensus` is its transaction: the state that is written.
    removalBreaks: removalBreaks(
      buildConflictInput(db, periodId),
      onShift.map((e) => e.assignment.id),
    ),
  });
  const name = (id: Id) => nurseName(nurseById.get(id) as Nurse);
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
  return firstInOrder(view, nurseId, {
    excluded: (e) => e.reason,
    notFirst: (first, mine) =>
      `${first.name} goes home before ${mine.name}. ${first.reason} Cancel ${first.name} first.`,
  });
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
  return transact(db, (tx) => {
    const shiftType = getShiftType(tx, shiftTypeId);
    if (!shiftType) throw new Error('That shift type was not found. Reload the page.');
    // Ranked once, here, and the reason worded from that place: what is logged is what is acted on.
    const current = nextInOrder(
      cancellationOrderFor(tx, periodId, date, shiftTypeId, role, volunteers),
      nurseId,
    );
    const reason = `Low census: ${current.name}, ${date} ${shiftType.abbreviation} — ${current.reason}`;
    const log = openChangeLog(tx, periodId, reason, 'census');
    const assignment = listAssignmentsForPeriodOnDate(tx, periodId, date).find(
      (a) => a.id === current.assignmentId,
    );
    if (!assignment) throw new Error('That nurse is no longer on this shift.');
    const record = recordShiftCancellation(
      tx,
      { periodId, nurseId, shiftTypeId, date, reason: current.reason },
      ACTOR,
    );
    // D13: reporting-time pay (half the shift, 2-4 hours) is owed only to a nurse who reported,
    // or was told less than the unit's notice before the start; one phoned the evening before is
    // owed nothing (IWC Wage Order 5 § 5 pays for reporting). When owed it is owed whether or not
    // the schedule still shows the shift, so the event is written with the cancellation, never
    // later. Hours worked start at 0; the manager edits them if the nurse stayed a while.
    const unitId = periodOrThrow(tx, periodId).unitId;
    const owed = reportingPayOwed({
      shiftStartMinute: shiftWindow(date, shiftType).startMinute,
      recordedAtMinute: hostWallMinute(),
      noticeHours: getPaySettings(tx, unitId).reportingPayNoticeHours,
    });
    if (owed) {
      createDayOfPayEvent(
        tx,
        {
          kind: 'sent_home',
          unitId,
          nurseId,
          date,
          shiftTypeId,
          scheduledHours: shiftType.durationHours,
          hoursWorked: 0,
          note: 'Low-census cancellation',
        },
        ACTOR,
      );
    }
    deleteAssignment(tx, assignment.id, ACTOR, reason);
    log({ kind: 'removed', assignment, before: assignment });
    return record;
  });
}
