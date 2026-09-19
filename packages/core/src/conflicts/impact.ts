/**
 * Fairness and cost impact between two simulated schedules.
 *
 * Resolution scoring and exchange evaluation both answer "what did this change do to the unit's
 * fairness score and its payroll?" against a `SimState` before/after pair. Neither depends on
 * what kind of change produced the two states, so the comparison lives here once rather than
 * being re-derived per caller — a second, slightly different formula for "cost delta" is exactly
 * the kind of drift that would make the resolution ranker and the exchange preview disagree
 * about the same dollar figure.
 */

import type { Id } from '../domain/entities.js';
import type { ConflictEngine, SimState } from './engine.js';
import type { CostImpact, FairnessImpact } from './types.js';

export function fairnessImpact(before: SimState, after: SimState): FairnessImpact {
  const a = before.fairness();
  const b = after.fairness();
  const affected: FairnessImpact['affected'] = [];
  const ids = new Set([...a.byNurse.keys(), ...b.byNurse.keys()]);
  for (const nurseId of [...ids].sort()) {
    const x = a.byNurse.get(nurseId) ?? 0;
    const y = b.byNurse.get(nurseId) ?? 0;
    if (Math.abs(x - y) > 1e-9) affected.push({ nurseId, before: x, after: y });
  }
  return { unitScoreBefore: a.mean, unitScoreAfter: b.mean, delta: b.mean - a.mean, affected };
}

/**
 * Cost is priced per nurse, and a nurse's timeline is priced independently of everyone else's,
 * so only the touched nurses need re-costing: the period total moves by exactly their difference.
 */
export function costImpact(
  engine: ConflictEngine,
  before: SimState,
  after: SimState,
  touched: readonly Id[],
): CostImpact {
  if (!engine.costCtx) return { dollarsBefore: 0, dollarsAfter: 0, delta: 0, unpriced: true };
  const dollarsBefore = before.costTotal();
  let delta = 0;
  let unpriced = false;
  for (const nurseId of touched) {
    const was = before.nurseCost(nurseId);
    const is = after.nurseCost(nurseId);
    delta += sumCost(is) - sumCost(was);
    if ([...was, ...is].some((c) => c.rateSource === 'none')) unpriced = true;
  }
  delta = cents(delta);
  return { dollarsBefore, dollarsAfter: cents(dollarsBefore + delta), delta, unpriced };
}

export function sumCost(costs: readonly { total: number }[]): number {
  return costs.reduce((acc, c) => acc + c.total, 0);
}

export function cents(x: number): number {
  return Math.round(x * 100) / 100;
}
