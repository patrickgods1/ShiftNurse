/**
 * Which hard breaches the solver's gate lets a nurse keep.
 *
 * A manager may lock shifts that already break a hard rule. Refusing every timeline with a
 * breach would freeze that nurse out of every other shift, so the gate tolerates the pinned
 * breach — but only that breach, no bigger. Counting violations is not enough: a consecutive
 * run is one violation whatever its length, so a count lets Generate grow a locked six-day run
 * to nine, join two locked runs into one, or trade the pinned breach for a different one.
 *
 * So a breach is tolerated only by identity *and* size, and each check alone leaks:
 * - every shift it names must be pinned (locked, or in the lookback tail) — without this, a
 *   breach whose dates match the pinned one but which now names a shift Generate placed passes;
 * - the pins alone must already have the same breach (`violationKey`) at least as big — without
 *   this, a new breach naming no shift at all passes, since `every` holds on an empty list.
 *
 * Identity is `violationKey` and "bigger" is `AMOUNT_EPSILON` past, the same definitions the
 * conflicts engine and exchange evaluator diff with; a second definition here would let the
 * gate and the grid disagree about whether a pinned breach grew.
 */

import type { Id } from '../domain/entities.js';
import type { Violation } from '../rules/types.js';
import { AMOUNT_EPSILON, violationKey } from '../rules/violation-diff.js';

/** violationKey → the largest amount any baseline violation under that key has. */
export function breachAllowance(baseline: readonly Violation[]): ReadonlyMap<string, number> {
  const allowance = new Map<string, number>();
  for (const v of baseline) {
    const key = violationKey(v);
    allowance.set(key, Math.max(allowance.get(key) ?? 0, v.amount));
  }
  return allowance;
}

/** Tolerated iff every id is pinned and the baseline holds the same breach at least as big. */
export function isTolerated(
  v: Violation,
  allowance: ReadonlyMap<string, number>,
  pinned: ReadonlySet<Id>,
): boolean {
  if (!v.assignmentIds.every((id) => pinned.has(id))) return false;
  const allowed = allowance.get(violationKey(v));
  return allowed !== undefined && !(v.amount > allowed + AMOUNT_EPSILON);
}
