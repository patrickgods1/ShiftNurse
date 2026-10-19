/**
 * Who a shift cannot spare: the hard breach taking each nurse off it would leave behind.
 *
 * Census cancellation and float rotation rank who leaves by the contract's order, and main acts
 * only on the first in it. Without this the first could be the only experienced RN beside two new
 * grads, the only holder of a credential the shift requires, or an orientee's preceptor — and the
 * manager, unable to skip her, would send her home and watch the grid turn red (H-12). An
 * exchange and a call-off replacement already promise the grid will not turn red; this gives the
 * removal paths the same promise by simulating each removal on the conflicts engine, the same
 * machinery the grid's verdict comes from.
 *
 * `understaffed` and `ratio_breach` are left out: they judge the period's planned demand, and the
 * whole point of a low-census cancellation is that the census on the floor is below plan. Counted,
 * they would forbid every cancellation; Today already judges staffing against the census on the
 * floor (`overstaffedRoles`). Only shift-scope findings are read: a removal takes hours away, so it
 * never adds a nurse-scope hard breach to anyone else, and the leaving nurse's own hours are her
 * contract's business, not the shift's.
 */

import { ConflictEngine } from '../conflicts/engine.js';
import type { ConflictInput } from '../conflicts/types.js';
import type { Id } from '../domain/entities.js';
import type { Violation, ViolationCode } from '../rules/types.js';
import { diffViolations } from '../rules/violation-diff.js';

/** Codes Today judges against the census on the floor (`overstaffedRoles`), not the plan. */
export const CENSUS_JUDGED_CODES: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  'understaffed',
  'ratio_breach',
]);

/**
 * For each assignment, the first hard shift-scope breach taking it off the schedule would
 * introduce or make worse, census-judged codes aside. Absent from the map: safe to remove.
 */
export function removalBreaks(
  input: ConflictInput,
  assignmentIds: readonly Id[],
): Map<Id, Violation> {
  const engine = new ConflictEngine(input);
  const before = engine.baseline();
  const breaks = new Map<Id, Violation>();
  for (const id of assignmentIds) {
    const a = input.assignments.find((row) => row.id === id);
    if (!a) throw new Error(`Unknown assignment ${id}.`);
    const after = engine.state(
      input.assignments.filter((row) => row.id !== id),
      input.timeOff,
      before,
    );
    const diff = diffViolations(
      before.shiftViolationsAround(a.date, a.shiftTypeId),
      after.shiftViolationsAround(a.date, a.shiftTypeId),
    );
    const broken = [...diff.introduced, ...diff.worsened.map((w) => w.after)].find(
      (v) => v.severity === 'hard' && !CENSUS_JUDGED_CODES.has(v.code),
    );
    if (broken) breaks.set(id, broken);
  }
  return breaks;
}
