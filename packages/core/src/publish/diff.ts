/**
 * What changed between two versions of a schedule, as a nurse would describe it.
 *
 * A published schedule is a promise to the unit: every nurse has planned their life around
 * it. When the manager republishes after edits, the question that matters is not "which rows
 * changed" but "whose shifts changed, and how" — that is what gets communicated to staff and
 * what a grievance is argued over. So the diff is keyed on the fact a nurse cares about
 * (who, which date, which shift), not on row ids: a regenerate that rewrites every id but
 * lands the same shifts is *no change*, and a shift handed from one nurse to another is a
 * removal for one and an addition for the other, never an anonymous "update".
 *
 * Locks and the `source` of a row are the manager's bookkeeping and invisible to the nurse,
 * so they are deliberately not compared.
 */

import type { Assignment, Id } from '../domain/entities.js';
import { compareDates, type IsoDate } from '../domain/time.js';

export type AssignmentChangeKind = 'added' | 'removed' | 'changed';

/** Fields a nurse would notice changing on a shift they keep. */
export type ComparedField = 'isCharge' | 'isOvertime' | 'notes';

const COMPARED_FIELDS: readonly ComparedField[] = ['isCharge', 'isOvertime', 'notes'];

export interface AssignmentChange {
  kind: AssignmentChangeKind;
  nurseId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  /** The row as it was before; absent for an addition. */
  before?: Assignment;
  /** The row as it is now; absent for a removal. */
  after?: Assignment;
  /** For `changed`: which of the compared fields differ. */
  fields?: ComparedField[];
}

export interface ScheduleDiff {
  added: number;
  removed: number;
  changed: number;
  /** Ordered by date, then nurse, then shift type — the order the grid reads in. */
  changes: AssignmentChange[];
  /** Every nurse with at least one change, sorted. */
  affectedNurseIds: Id[];
}

function key(a: Assignment): string {
  return `${a.nurseId}::${a.date}::${a.shiftTypeId}`;
}

function compareChanges(a: AssignmentChange, b: AssignmentChange): number {
  return (
    compareDates(a.date, b.date) ||
    a.nurseId.localeCompare(b.nurseId) ||
    a.shiftTypeId.localeCompare(b.shiftTypeId)
  );
}

export function diffAssignments(
  before: readonly Assignment[],
  after: readonly Assignment[],
): ScheduleDiff {
  const beforeByKey = new Map(before.map((a) => [key(a), a]));
  const afterByKey = new Map(after.map((a) => [key(a), a]));
  const changes: AssignmentChange[] = [];

  for (const [k, prev] of beforeByKey) {
    const next = afterByKey.get(k);
    if (!next) {
      changes.push({
        kind: 'removed',
        nurseId: prev.nurseId,
        date: prev.date,
        shiftTypeId: prev.shiftTypeId,
        before: prev,
      });
      continue;
    }
    const fields = COMPARED_FIELDS.filter((f) => (prev[f] ?? undefined) !== (next[f] ?? undefined));
    if (fields.length > 0) {
      changes.push({
        kind: 'changed',
        nurseId: prev.nurseId,
        date: prev.date,
        shiftTypeId: prev.shiftTypeId,
        before: prev,
        after: next,
        fields,
      });
    }
  }
  for (const [k, next] of afterByKey) {
    if (beforeByKey.has(k)) continue;
    changes.push({
      kind: 'added',
      nurseId: next.nurseId,
      date: next.date,
      shiftTypeId: next.shiftTypeId,
      after: next,
    });
  }

  changes.sort(compareChanges);
  const count = (kind: AssignmentChangeKind) => changes.filter((c) => c.kind === kind).length;
  return {
    added: count('added'),
    removed: count('removed'),
    changed: count('changed'),
    changes,
    affectedNurseIds: [...new Set(changes.map((c) => c.nurseId))].sort(),
  };
}
