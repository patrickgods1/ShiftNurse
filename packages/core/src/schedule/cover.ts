/**
 * Shifts that run inside another — cover by the hour, as units judge it.
 *
 * A unit asks who is on the floor during a shift's hours, not which shift type they are booked
 * on. An 8 from 07:00 to 15:00 inside the day 12 is run by the day 12's charge nurse, covered by
 * its ACLS nurse, and a new grad on it works beside the day 12's experienced RNs. Judging the 8
 * on its own roster would demand a second charge nurse and a second ACLS nurse on the unit for
 * those eight hours, which no hospital staffs to, and would ignore the RNs actually there.
 *
 * A shift type names the one it runs inside (`withinShiftTypeId`). Its window must lie inside
 * that shift's on the same day or, for a shift inside a night, the day the night began; and the
 * containing shift must be standalone, so cover never chains. Every consumer — the coverage
 * rule, `SolverModel`, the CP-SAT encoder and the conflicts engine — finds the covering shift
 * here, so they cannot disagree about which night covers which early-morning shift.
 */

import type { Id, ShiftType } from '../domain/entities.js';
import { addDays, type IsoDate, isoDate, type ShiftTiming, shiftWindow } from '../domain/time.js';

/** The date of the `outer` shift whose window contains `inner` worked on `date`, if any. */
export function containingDate(
  inner: ShiftTiming,
  outer: ShiftTiming,
  date: IsoDate,
): IsoDate | undefined {
  const window = shiftWindow(date, inner);
  for (const candidate of [date, addDays(date, -1)]) {
    const around = shiftWindow(candidate, outer);
    if (around.startMinute <= window.startMinute && window.endMinute <= around.endMinute) {
      return candidate;
    }
  }
  return undefined;
}

/** The dated shift covering `inner` on `date`, or undefined for a standalone shift. */
export function coveringShift(
  inner: ShiftType,
  date: IsoDate,
  shiftTypesById: ReadonlyMap<Id, ShiftType>,
): { shiftType: ShiftType; date: IsoDate } | undefined {
  if (inner.withinShiftTypeId === null) return undefined;
  const outer = shiftTypesById.get(inner.withinShiftTypeId);
  if (!outer) return undefined;
  const at = containingDate(inner, outer, date);
  return at === undefined ? undefined : { shiftType: outer, date: at };
}

/**
 * Why `inner` cannot run inside `outer`, or undefined when it can. Checked when a shift type is
 * saved, so a covering shift is always a standalone one whose hours contain the inner shift's.
 */
export function withinShiftProblem(
  inner: ShiftType,
  outer: ShiftType | undefined,
): string | undefined {
  if (inner.withinShiftTypeId === null) return undefined;
  if (!outer) return `Shift type ${inner.withinShiftTypeId} does not exist`;
  if (outer.id === inner.id) return `${inner.name} cannot run inside itself`;
  if (outer.unitId !== inner.unitId) return `${outer.name} belongs to another unit`;
  if (outer.withinShiftTypeId !== null) {
    return `${outer.name} itself runs inside another shift; choose a standalone shift`;
  }
  if (inner.isOnCall || outer.isOnCall)
    return 'On-call shifts cannot contain or run inside a shift';
  // Every day is the same 1440 minutes on the wall-clock timeline, so any date will do.
  if (containingDate(inner, outer, isoDate('2026-01-07')) === undefined) {
    return `${inner.name} (${inner.startTime}, ${inner.durationHours}h) does not fit inside the hours of ${outer.name} (${outer.startTime}, ${outer.durationHours}h)`;
  }
  return undefined;
}
