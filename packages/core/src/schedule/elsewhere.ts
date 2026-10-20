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
 *
 * A shift the nurse was floated off (`Assignment.floatedTo`) is the same thing seen from home:
 * she worked those hours, on another unit's floor. `floatedOff` copies its type as an inactive
 * `floated:<id>` type marked `elsewhere`, so every rule judges it exactly as it judges 5 West's
 * shifts. The prefix differs from `elsewhere:` because this unit's own same-unit overlap rows
 * already take `elsewhere:<this unit's type id>`, and two copies sharing an id with different
 * names would collide in `shiftTypesById`.
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

/** True for a shift the nurse was floated off to another unit. */
export function isFloatedOff(a: Pick<Assignment, 'floatedTo'>): boolean {
  return a.floatedTo !== undefined;
}

/**
 * Shifts the nurse was floated off, as busy time on their own unit: each type copied as an
 * inactive `floated:<id>` type ("Day 12 (floated out)") marked `elsewhere`, each row locked.
 * Rules then judge them exactly as another unit's shifts (rest, hours, overtime, days off yes;
 * floor, coverage, charge no).
 */
export function floatedOff(
  assignments: readonly Assignment[],
  shiftTypes: readonly ShiftType[],
): BusyElsewhere {
  const byId = new Map(shiftTypes.map((t) => [t.id, t]));
  const used = new Map<string, ShiftType>();
  const out: Assignment[] = [];
  for (const a of assignments) {
    // A row that was never floated would vanish from this unit's floor if it came through here.
    if (!isFloatedOff(a)) throw new Error(`Shift ${a.id} was not floated off`);
    const type = byId.get(a.shiftTypeId);
    if (!type) throw new Error(`Shift ${a.id} has unknown shift type ${a.shiftTypeId}`);
    const id = `floated:${type.id}`;
    if (!used.has(id)) {
      used.set(id, {
        ...type,
        id,
        name: `${type.name} (floated out)`,
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
