/**
 * Who is on the floor at the same time — judged by the hour, as units judge it.
 *
 * Nurses who must not work together are kept apart by the hours they are actually on the unit,
 * not by the shift type they are booked on: an 11:00–23:00 mid overlaps both the day 12 and the
 * night that follows, and a D8 inside a D12 overlaps it. Windows are half-open, so a night ending
 * at 07:00 does not overlap a day shift starting at 07:00. On-call standby is not on the floor.
 *
 * The incompatibility rules, `SolverModel`, the CP-SAT encoder and the conflicts engine all read
 * the floor through here, so they cannot disagree about who was on together.
 */

import type { ShiftType } from '../domain/entities.js';
import {
  addDays,
  type IsoDate,
  type ShiftWindow,
  shiftWindow,
  windowsOverlap,
} from '../domain/time.js';

export interface DatedShift {
  date: IsoDate;
  shiftType: ShiftType;
}

/**
 * The other dated shifts whose hours overlap this one's, in date then shift-type order. A shift
 * type lasts at most a day, so only the day before, the day itself and the day after can overlap.
 */
export function overlappingShifts(
  date: IsoDate,
  shiftType: ShiftType,
  shiftTypes: readonly ShiftType[],
): DatedShift[] {
  if (shiftType.isOnCall) return [];
  const window = shiftWindow(date, shiftType);
  const out: DatedShift[] = [];
  for (const other of [addDays(date, -1), date, addDays(date, 1)]) {
    for (const type of shiftTypes) {
      if (type.isOnCall) continue;
      if (type.id === shiftType.id && other === date) continue;
      if (windowsOverlap(window, shiftWindow(other, type)))
        out.push({ date: other, shiftType: type });
    }
  }
  return out;
}

/** A stretch of time with the same people on the floor throughout. */
export interface FloorSegment<T> {
  startMinute: number;
  endMinute: number;
  /** Everything whose window covers the whole stretch, in input order. */
  on: T[];
}

/**
 * Cut the hours inside `within` into stretches at every start and end, each with the items on
 * the floor throughout it. Stretches nobody is on are left out. `within` is the hours being
 * judged — the whole period on the grid, one shift's hours in a simulation.
 */
export function floorSegments<T extends { window: ShiftWindow }>(
  items: readonly T[],
  within: readonly ShiftWindow[],
): FloorSegment<T>[] {
  const cuts = new Set<number>();
  for (const w of within) {
    cuts.add(w.startMinute);
    cuts.add(w.endMinute);
  }
  for (const item of items) {
    cuts.add(item.window.startMinute);
    cuts.add(item.window.endMinute);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: FloorSegment<T>[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const startMinute = points[i]!;
    const endMinute = points[i + 1]!;
    if (!within.some((w) => w.startMinute <= startMinute && endMinute <= w.endMinute)) continue;
    const on = items.filter(
      (item) => item.window.startMinute <= startMinute && endMinute <= item.window.endMinute,
    );
    if (on.length > 0) out.push({ startMinute, endMinute, on });
  }
  return out;
}
