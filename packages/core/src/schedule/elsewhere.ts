/**
 * Shifts a nurse works on another unit, as busy time on this one.
 *
 * A float nurse, or anyone on two units' rosters, is scheduled by each unit on its own, and
 * neither knew the other had them: a nurse could be on 5 West's day shift and this unit's night
 * before it, or forty hours here and twenty there without anyone counting sixty. The rules
 * already judge a nurse's whole timeline, so another unit's shifts only need to be on it.
 *
 * They arrive as this unit sees them: each other-unit shift type copied as an inactive type
 * (`elsewhere:<id>`, "Day 12 on 5 West") — inactive, so demand, coverage and both solvers leave
 * it alone — and each shift locked, for the list of shifts that are judged but never flagged or
 * moved (the lookback tail's list, `priorAssignments`). Rest, overlap, hours and overtime then
 * count them; this unit's coverage, fairness and cost do not, which is right: they are 5 West's.
 *
 * The copy carries `ShiftType.elsewhere`, and `isElsewhere` is the one test for it. A nurse busy
 * on 5 West is not on this unit's floor, so the incompatibility floor, `SolverModel`'s floor
 * stretches and CP-SAT's terms leave those shifts out: without the marker a kept-apart pair split
 * across two units read as together here, and a nurse on 5 West stood in for this floor's
 * outside staff. The marker, not the id prefix, so renaming the prefix cannot quietly undo that.
 */

import type { Assignment, ShiftType } from '../domain/entities.js';

export interface BusyElsewhere {
  shiftTypes: ShiftType[];
  assignments: Assignment[];
}

export function busyElsewhere(
  assignments: readonly Assignment[],
  otherShiftTypes: readonly ShiftType[],
  otherUnitName: string,
): BusyElsewhere {
  const byId = new Map(otherShiftTypes.map((t) => [t.id, t]));
  const used = new Map<string, ShiftType>();
  const out: Assignment[] = [];
  for (const a of assignments) {
    const type = byId.get(a.shiftTypeId);
    // Bad data is loud: a shift with no type cannot be placed on anyone's timeline.
    if (!type)
      throw new Error(`Shift ${a.id} on ${otherUnitName} has unknown shift type ${a.shiftTypeId}`);
    const id = `elsewhere:${type.id}`;
    if (!used.has(id)) {
      used.set(id, {
        ...type,
        id,
        name: `${type.name} on ${otherUnitName}`,
        active: false,
        withinShiftTypeId: null,
        elsewhere: true,
      });
    }
    out.push({ ...a, shiftTypeId: id, isLocked: true, isCharge: false });
  }
  return { shiftTypes: [...used.values()], assignments: out };
}

/** Whether a shift type is another unit's work: busy time for the nurse, not this unit's floor. */
export function isElsewhere(shiftType: Pick<ShiftType, 'elsewhere'>): boolean {
  return shiftType.elsewhere === true;
}
