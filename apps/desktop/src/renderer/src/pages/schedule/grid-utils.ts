/**
 * Pure layout helpers for the schedule grid — cell keys, nurse ordering, chip sizing and the
 * "is this a not-yet-saved optimistic chip" test — kept out of the grid component so the
 * indexing logic can be reasoned about without React.
 */

import type {
  Assignment,
  Id,
  IsoDate,
  Nurse,
  NurseRole,
  ShiftDemand,
  ShiftType,
  Violation,
} from '@shiftnurse/core';

export function cellKey(nurseId: Id, date: IsoDate): string {
  return `${nurseId}__${date}`;
}

/** Rows are active nurses only, sorted by last name (the way the unit calls the roster). */
export function sortNurses(nurses: readonly Nurse[]): Nurse[] {
  return [...nurses]
    .filter((n) => n.active)
    .sort((a, b) => {
      const byLast = a.lastName.localeCompare(b.lastName);
      return byLast !== 0 ? byLast : a.firstName.localeCompare(b.firstName);
    });
}

export function buildCellIndex<T extends Pick<Assignment, 'nurseId' | 'date'>>(
  assignments: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const assignment of assignments) {
    const key = cellKey(assignment.nurseId, assignment.date);
    const existing = map.get(key);
    if (existing) existing.push(assignment);
    else map.set(key, [assignment]);
  }
  return map;
}

/** Optimistic chips get a client-generated id so the grid can render them before the round trip
 * completes; this is how the renderer tells them apart from a persisted assignment. */
const PENDING_PREFIX = 'pending-';

export function makePendingId(): Id {
  return `${PENDING_PREFIX}${Math.random().toString(36).slice(2)}`;
}

export function isPendingId(id: Id): boolean {
  return id.startsWith(PENDING_PREFIX);
}

/** A 12h chip reads as full width; shorter shifts are visibly narrower/shorter so the manager
 * can spot the 8/12 mix at a glance without reading every abbreviation. */
export function chipWidthClass(durationHours: number): string {
  if (durationHours >= 12) return 'w-full';
  if (durationHours >= 10) return 'w-5/6';
  if (durationHours >= 8) return 'w-2/3';
  return 'w-1/2';
}

export function chipHeightClass(durationHours: number): string {
  if (durationHours >= 12) return 'h-8';
  if (durationHours >= 8) return 'h-6';
  return 'h-5';
}

export const SHORT_WEEKDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

/** Violations have no id of their own; the rule plus the entities it names is stable and
 * unique enough within one validation result to key a React list on. */
export function violationKey(violation: Violation): string {
  return [
    violation.ruleId,
    ...violation.nurseIds,
    ...violation.assignmentIds,
    ...violation.dates,
  ].join('|');
}

export interface HeadcountCell {
  date: IsoDate;
  staffed: number;
  /** The hard minimum for that shift and role (`RoleDemand.minCount`); 0 when none is set. */
  required: number;
}

export interface HeadcountRow {
  shiftType: ShiftType;
  role: NurseRole;
  cells: HeadcountCell[];
}

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];

/**
 * The rows under the grid a manager reads first — "Monday days: 6 RNs of 6" — one per worked
 * shift type and role that anyone needs or works this period. Required comes from the same
 * demand the rules judge by, so a red cell here is a short shift on the violation list too.
 */
export function headcountRows(input: {
  shiftTypes: readonly ShiftType[];
  nurses: readonly Nurse[];
  assignments: readonly Pick<Assignment, 'nurseId' | 'date' | 'shiftTypeId'>[];
  demand: readonly ShiftDemand[];
  dates: readonly IsoDate[];
}): HeadcountRow[] {
  const roleOf = new Map(input.nurses.map((n) => [n.id, n.role]));
  const staffed = new Map<string, number>();
  for (const a of input.assignments) {
    const role = roleOf.get(a.nurseId);
    if (!role) continue;
    const key = `${a.date}|${a.shiftTypeId}|${role}`;
    staffed.set(key, (staffed.get(key) ?? 0) + 1);
  }
  const required = new Map<string, number>();
  for (const d of input.demand) {
    for (const role of ROLES) {
      required.set(`${d.date}|${d.shiftTypeId}|${role}`, d.byRole[role]?.minCount ?? 0);
    }
  }
  const rows: HeadcountRow[] = [];
  const worked = input.shiftTypes
    .filter((st) => st.active && !st.isOnCall)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const shiftType of worked) {
    for (const role of ROLES) {
      const cells = input.dates.map((date) => {
        const key = `${date}|${shiftType.id}|${role}`;
        return { date, staffed: staffed.get(key) ?? 0, required: required.get(key) ?? 0 };
      });
      if (cells.some((c) => c.staffed > 0 || c.required > 0)) {
        rows.push({ shiftType, role, cells });
      }
    }
  }
  return rows;
}

export interface StaffingSummaryCell {
  date: IsoDate;
  /** People missing that day, summed over every shift and role that is under its minimum. */
  short: number;
  /** "D12 RN 1/2" for each shift and role under its minimum, for the cell's tooltip. */
  details: string[];
}

/**
 * The single row that stands in for the per-shift headcount rows on a small screen: one number a
 * day. Shortfalls are summed per shift and role, never netted — a spare RN on days does not cover
 * a missing CNA, and adding staffed and required across rows first would say it does.
 */
export function staffingSummary(
  rows: readonly HeadcountRow[],
  dates: readonly IsoDate[],
): StaffingSummaryCell[] {
  return dates.map((date, col) => {
    let short = 0;
    const details: string[] = [];
    for (const row of rows) {
      const cell = row.cells[col];
      if (!cell || cell.staffed >= cell.required) continue;
      short += cell.required - cell.staffed;
      details.push(`${row.shiftType.abbreviation} ${row.role} ${cell.staffed}/${cell.required}`);
    }
    return { date, short, details };
  });
}
