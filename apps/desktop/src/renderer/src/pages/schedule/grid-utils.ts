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
import { violationKey } from '@shiftnurse/core';
import { formatMonthYear } from '../../format.js';

export function cellKey(nurseId: Id, date: IsoDate): string {
  return `${nurseId}__${date}`;
}

function byName(a: Nurse, b: Nurse): number {
  const byLast = a.lastName.localeCompare(b.lastName);
  return byLast !== 0 ? byLast : a.firstName.localeCompare(b.firstName);
}

/** Active nurses only, sorted by last name (the way the unit calls the roster). This is who a
 * shift may be moved or added to; the grid's own rows come from `gridNurses`. */
export function sortNurses(nurses: readonly Nurse[]): Nurse[] {
  return [...nurses].filter((n) => n.active).sort(byName);
}

/**
 * The grid's rows: every active nurse, plus any nurse who has left but still holds a shift. Her
 * shifts count as staffed, so dropping her row left shifts nobody could see, move or remove.
 */
export function gridNurses(
  nurses: readonly Nurse[],
  assignments: readonly Pick<Assignment, 'nurseId'>[],
): Nurse[] {
  const holders = new Set(assignments.map((a) => a.nurseId));
  return [...nurses].filter((n) => n.active || holders.has(n.id)).sort(byName);
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

/** Everything one nurse's row draws from the period-wide indexes, and nothing else. */
export interface RowSlice {
  cells: ReadonlyMap<IsoDate, readonly Assignment[]>;
  /** Violations on this row's assignments only. */
  violations: ReadonlyMap<Id, readonly Violation[]>;
  nurseViolations: readonly Violation[];
  /** Preference notes for this row's assignments only. */
  preferenceNotes: ReadonlyMap<Id, string>;
}

const NO_VIOLATIONS: readonly Violation[] = [];

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function sameSlice(a: RowSlice, b: RowSlice): boolean {
  if (!sameItems(a.nurseViolations, b.nurseViolations)) return false;
  if (a.cells.size !== b.cells.size) return false;
  for (const [date, list] of a.cells) {
    const other = b.cells.get(date);
    if (!other || !sameItems(list, other)) return false;
  }
  if (a.violations.size !== b.violations.size) return false;
  for (const [id, list] of a.violations) {
    const other = b.violations.get(id);
    if (!other || !sameItems(list, other)) return false;
  }
  if (a.preferenceNotes.size !== b.preferenceNotes.size) return false;
  for (const [id, note] of a.preferenceNotes) if (b.preferenceNotes.get(id) !== note) return false;
  return true;
}

/**
 * Splits the period-wide indexes into one slice per nurse, and hands back the previous slice
 * whenever nothing in the row changed. A row is skipped by `React.memo` only if its props are
 * identical, and the whole-period maps are rebuilt on every refetch, so without this a single new
 * shift redrew every chip on the grid. Comparison is by identity (`===`), not by value: TanStack
 * Query keeps unchanged rows and violations as the same objects across a refetch, and a deep
 * compare would cost more than the render it saves.
 */
export function rowSlices(input: {
  nurses: readonly Nurse[];
  assignments: readonly Assignment[];
  violationsByAssignment: ReadonlyMap<Id, readonly Violation[]>;
  violationsByNurse: ReadonlyMap<Id, readonly Violation[]>;
  preferenceNotes: ReadonlyMap<Id, string>;
  previous?: ReadonlyMap<Id, RowSlice> | undefined;
}): Map<Id, RowSlice> {
  const byNurse = new Map<Id, Assignment[]>();
  for (const a of input.assignments) {
    const list = byNurse.get(a.nurseId);
    if (list) list.push(a);
    else byNurse.set(a.nurseId, [a]);
  }
  const out = new Map<Id, RowSlice>();
  for (const nurse of input.nurses) {
    const cells = new Map<IsoDate, Assignment[]>();
    const violations = new Map<Id, readonly Violation[]>();
    const preferenceNotes = new Map<Id, string>();
    for (const a of byNurse.get(nurse.id) ?? []) {
      const day = cells.get(a.date);
      if (day) day.push(a);
      else cells.set(a.date, [a]);
      const found = input.violationsByAssignment.get(a.id);
      if (found) violations.set(a.id, found);
      const note = input.preferenceNotes.get(a.id);
      if (note !== undefined) preferenceNotes.set(a.id, note);
    }
    const slice: RowSlice = {
      cells,
      violations,
      nurseViolations: input.violationsByNurse.get(nurse.id) ?? NO_VIOLATIONS,
      preferenceNotes,
    };
    const before = input.previous?.get(nurse.id);
    out.set(nurse.id, before && sameSlice(before, slice) ? before : slice);
  }
  return out;
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

export interface MonthSpan {
  label: string;
  /** Index of the first column in this month. */
  start: number;
  count: number;
}

/**
 * The months a run of columns falls in, each with how many columns it covers, for the band over
 * the date row. The day number alone ("29, 30, 31, 1, 2") is why a six-week schedule reads as
 * one blur: the band says where October ends and November starts.
 */
export function monthSpans(dates: readonly IsoDate[]): MonthSpan[] {
  const spans: MonthSpan[] = [];
  dates.forEach((date, index) => {
    const label = formatMonthYear(date);
    const last = spans[spans.length - 1];
    if (last && last.label === label) last.count += 1;
    else spans.push({ label, start: index, count: 1 });
  });
  return spans;
}

/**
 * Violations have no id of their own, so a React list needs one made. Core's `violationKey` is
 * the identity (shift, role, credential, group or nurses) but is not unique within one result:
 * the ratio rule's per-role RN breach and its `rn_share` breach on the same shift share it.
 * The occurrence index separates those, and stays stable for a given list order.
 */
export function keyedViolations(
  violations: readonly Violation[],
): { key: string; violation: Violation }[] {
  const seen = new Map<string, number>();
  return violations.map((violation) => {
    const base = violationKey(violation);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: `${base}#${n}`, violation };
  });
}

export interface HeadcountCell {
  date: IsoDate;
  staffed: number;
  /** The hard minimum for that shift and role (`RoleDemand.minCount`); 0 when none is set. */
  required: number;
}

export interface HeadcountRow {
  shiftType: ShiftType;
  /** 'licensed' is the pooled RN + LPN count a licensed ratio rule judges. */
  role: NurseRole | 'licensed';
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
  assignments: readonly Pick<Assignment, 'nurseId' | 'date' | 'shiftTypeId' | 'floatedTo'>[];
  demand: readonly ShiftDemand[];
  dates: readonly IsoDate[];
}): HeadcountRow[] {
  const roleOf = new Map(input.nurses.map((n) => [n.id, n.role]));
  const staffed = new Map<string, number>();
  for (const a of input.assignments) {
    // Floated off: her hours still count elsewhere, but she is not on this unit's floor.
    if (a.floatedTo !== undefined) continue;
    const role = roleOf.get(a.nurseId);
    if (!role) continue;
    const key = `${a.date}|${a.shiftTypeId}|${role}`;
    staffed.set(key, (staffed.get(key) ?? 0) + 1);
  }
  const required = new Map<string, number>();
  const pooled = new Set<string>();
  for (const d of input.demand) {
    for (const role of ROLES) {
      required.set(`${d.date}|${d.shiftTypeId}|${role}`, d.byRole[role]?.minCount ?? 0);
    }
    if (d.licensed) {
      pooled.add(d.shiftTypeId);
      required.set(`${d.date}|${d.shiftTypeId}|licensed`, d.licensed.ratioDerived);
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
    if (pooled.has(shiftType.id)) {
      const cells = input.dates.map((date) => ({
        date,
        staffed:
          (staffed.get(`${date}|${shiftType.id}|RN`) ?? 0) +
          (staffed.get(`${date}|${shiftType.id}|LPN`) ?? 0),
        required: required.get(`${date}|${shiftType.id}|licensed`) ?? 0,
      }));
      rows.push({ shiftType, role: 'licensed', cells });
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
 * a missing CNA, and adding staffed and required across rows first would say it does. The
 * licensed pool counts only what the RN shortfall leaves: every RN it is short is also one of the
 * pool, so the sum is the fewest nurses that fix both (`licensedBreaches`' `rnShort` + `poolExtra`).
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
      const missing = cell.required - cell.staffed;
      if (row.role === 'licensed') {
        const rnCell = rows.find((r) => r.shiftType.id === row.shiftType.id && r.role === 'RN')
          ?.cells[col];
        const rnShort = rnCell ? Math.max(0, rnCell.required - rnCell.staffed) : 0;
        const extra = missing - Math.min(missing, rnShort);
        if (extra === 0) continue;
        short += extra;
        details.push(`${row.shiftType.abbreviation} RN+LPN ${cell.staffed}/${cell.required}`);
        continue;
      }
      short += missing;
      details.push(`${row.shiftType.abbreviation} ${row.role} ${cell.staffed}/${cell.required}`);
    }
    return { date, short, details };
  });
}
