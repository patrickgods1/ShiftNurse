/**
 * Pure layout helpers for the schedule grid — cell keys, nurse ordering, chip sizing and the
 * "is this a not-yet-saved optimistic chip" test — kept out of the grid component so the
 * indexing logic can be reasoned about without React.
 */

import type { Assignment, Id, IsoDate, Nurse, Violation } from '@shiftnurse/core';

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
