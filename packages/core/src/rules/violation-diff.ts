/**
 * Identity and diffing for violations across two simulated schedules.
 *
 * Resolution scoring, exchange evaluation and the day-of replacement check ask the same
 * question — "did this change introduce, worsen or clear a violation?" — by comparing two
 * violation lists keyed on identity rather than object reference (a violation recomputed from
 * scratch on a copied schedule is never `===` the original even when nothing about it changed).
 * Shared here so the callers never drift on what "the same violation" means, which would let one
 * silently miss an introduced hard rule another catches.
 *
 * It lives in `rules/`, beside `Violation`, because the solver needs it too and `conflicts/`
 * already imports `solver/`: kept there, the solver could not use it without an import cycle.
 */

import { getRule } from './registry.js';
import type { Violation } from './types.js';

/**
 * Identity of a violation across two schedules. A shift-scope violation lists its whole roster
 * in `nurseIds`, so it is keyed by the shift and role instead — otherwise adding one nurse
 * would make a still-missing charge nurse read as both cleared and introduced. An incompatibility
 * violation is keyed by its group and dates, not its hours: a simulation judges each shift's hours
 * separately, and the same pairing seen from the day 12 and the mid beside it is one problem.
 */
export function violationKey(v: Violation): string {
  const d = v.details ?? {};
  const who =
    getRule(v.ruleId)?.scope === 'shift'
      ? `${d.shiftTypeId ?? ''}|${d.role ?? ''}|${d.credentialId ?? ''}|${d.groupId ?? ''}`
      : [...v.nurseIds].sort().join(',');
  return `${v.ruleId}|${v.code}|${v.dates.join(',')}|${who}`;
}

/**
 * How much an amount must grow to count as worse. Amounts are sums of fractional hours, and
 * the same breach summed in a different order must not read as a change.
 */
export const AMOUNT_EPSILON = 1e-9;

export interface WorsenedViolation {
  before: Violation;
  after: Violation;
}

export interface ViolationDiff {
  /** In `after` with no counterpart in `before`. */
  introduced: Violation[];
  /** The same breach, further past its limit. */
  worsened: WorsenedViolation[];
  /** In `before` with no counterpart in `after`. */
  cleared: Violation[];
}

function byKey(list: readonly Violation[]): Map<string, Violation[]> {
  const groups = new Map<string, Violation[]>();
  for (const v of list) {
    const key = violationKey(v);
    const group = groups.get(key);
    if (group) group.push(v);
    else groups.set(key, [v]);
  }
  return groups;
}

/**
 * Pairs each key's violations largest first, so two breaches sharing a key are never merged
 * into one and a standing breach that grows (60 h against a 48 h cap becoming 72 h) is
 * reported as worsened instead of vanishing because its key did not change.
 */
export function diffViolations(
  before: readonly Violation[],
  after: readonly Violation[],
): ViolationDiff {
  const wasThere = byKey(before);
  const isThere = byKey(after);
  const introducedSet = new Set<Violation>();
  const clearedSet = new Set<Violation>();
  const worsenedBy = new Map<Violation, Violation>();
  // Array.prototype.sort is stable, so ties keep their order of appearance.
  const largestFirst = (list: Violation[]) => [...list].sort((a, b) => b.amount - a.amount);

  for (const [key, afterGroup] of isThere) {
    const was = largestFirst(wasThere.get(key) ?? []);
    const is = largestFirst(afterGroup);
    is.forEach((v, i) => {
      const counterpart = was[i];
      if (counterpart === undefined) introducedSet.add(v);
      else if (v.amount > counterpart.amount + AMOUNT_EPSILON) worsenedBy.set(v, counterpart);
    });
    for (const v of was.slice(is.length)) clearedSet.add(v);
  }
  for (const [key, beforeGroup] of wasThere) {
    if (!isThere.has(key)) for (const v of beforeGroup) clearedSet.add(v);
  }

  const worsened: WorsenedViolation[] = [];
  for (const v of after) {
    const was = worsenedBy.get(v);
    if (was) worsened.push({ before: was, after: v });
  }
  return {
    introduced: after.filter((v) => introducedSet.has(v)),
    worsened,
    cleared: before.filter((v) => clearedSet.has(v)),
  };
}
