/**
 * The lean fairness evaluator the conflicts engine scores every simulated fix with must give
 * exactly — not approximately — the numbers `scoreFairness` gives: a resolution card shows the
 * unit score before and after, and the Fairness page shows the same schedule's score. The
 * oracle here is `scoreFairness` itself on random units, histories and period counters.
 */

import { describe, expect, it } from 'vitest';
import type { FairnessLedgerEntry, Id, Nurse } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import { Rng } from '../solver/rng.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { FairnessEvaluator } from './evaluator.js';
import { scoreFairness } from './score.js';
import { type BurdenCounters, DEFAULT_FAIRNESS_WEIGHTS } from './types.js';

function randomCounters(rng: Rng): BurdenCounters {
  const approved = rng.nextInt(0, 3);
  return {
    nightShifts: rng.nextInt(0, 8),
    weekendsWorked: rng.nextInt(0, 3),
    holidaysWorked: rng.nextInt(0, 1),
    onCallShifts: rng.nextInt(0, 2),
    undesirableShifts: rng.nextInt(0, 4),
    requestsApproved: approved,
    requestsDenied: rng.nextInt(0, 2),
    callOutsCovered: rng.nextInt(0, 2),
    totalHours: rng.nextInt(0, 7) * 12,
    overtimeHours: rng.nextInt(0, 1) * 12,
    preferenceHitRate: rng.nextInt(0, 10) / 10,
  };
}

function randomUnit(seed: number): {
  nurses: Nurse[];
  history: FairnessLedgerEntry[];
  current: Map<Id, BurdenCounters>;
  rng: Rng;
} {
  resetFixtureCounters();
  const rng = new Rng(seed);
  const nurses = Array.from({ length: rng.nextInt(3, 14) }, (_, i) =>
    makeNurse({
      // Per diem (0) mixed in: they drop out of fair-share comparisons.
      contractedHoursPerPeriod: [0, 36, 64, 72][rng.nextInt(0, 3)]!,
      seniorityDate: isoDate(`20${10 + (i % 12)}-03-01`),
    }),
  );
  const history: FairnessLedgerEntry[] = [];
  for (const nurse of nurses) {
    const periods = rng.nextInt(0, 8);
    for (let p = 0; p < periods; p++) {
      history.push({
        id: `${nurse.id}-h${p}`,
        nurseId: nurse.id,
        periodId: `period-${p}`,
        periodStart: addDays(isoDate('2025-01-05'), p * 42),
        ...randomCounters(rng),
      });
    }
  }
  const current = new Map(nurses.map((n) => [n.id, randomCounters(rng)]));
  return { nurses, history, current, rng };
}

function oracle(
  nurses: readonly Nurse[],
  history: readonly FairnessLedgerEntry[],
  current: ReadonlyMap<Id, BurdenCounters>,
) {
  const report = scoreFairness({
    nurses,
    current,
    history,
    preferences: [],
    weights: DEFAULT_FAIRNESS_WEIGHTS,
  });
  return {
    mean: report.distribution.score.mean,
    byNurse: new Map(report.scores.map((s) => [s.nurseId, s.score])),
  };
}

describe('scoring a simulated fix for fairness', () => {
  it('gives exactly the unit and per-nurse scores the Fairness page would', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { nurses, history, current } = randomUnit(seed);
      const evaluator = new FairnessEvaluator({
        nurses,
        history,
        weights: DEFAULT_FAIRNESS_WEIGHTS,
      });
      const lean = evaluator.score(current);
      const full = oracle(nurses, history, current);
      expect(lean.mean, `seed ${seed}`).toBe(full.mean);
      expect([...lean.byNurse], `seed ${seed}`).toEqual([...full.byNurse]);
    }
  });

  it('stays exact as one fix after another changes a few nurses and goes back', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { nurses, history, current, rng } = randomUnit(seed);
      const evaluator = new FairnessEvaluator({
        nurses,
        history,
        weights: DEFAULT_FAIRNESS_WEIGHTS,
      });
      const baseline = new Map(current);
      for (let step = 0; step < 12; step++) {
        // A candidate fix touches one or two nurses; every other step returns to the baseline,
        // as analysis does between candidates.
        const world = step % 2 === 0 ? new Map(baseline) : new Map(current);
        for (let k = 0; k < rng.nextInt(1, 2); k++) {
          const nurse = nurses[rng.nextInt(0, nurses.length - 1)]!;
          world.set(nurse.id, randomCounters(rng));
        }
        const lean = evaluator.score(world);
        const full = oracle(nurses, history, world);
        expect(lean.mean, `seed ${seed} step ${step}`).toBe(full.mean);
        expect([...lean.byNurse], `seed ${seed} step ${step}`).toEqual([...full.byNurse]);
      }
    }
  });

  it('re-scores a nurse whose only change is one more of any single counter', () => {
    // A fix that hands Ana one more night changes one number; reusing her old totals then
    // would leave the card's fairness delta at zero.
    const { nurses, history, current } = randomUnit(11);
    const evaluator = new FairnessEvaluator({ nurses, history, weights: DEFAULT_FAIRNESS_WEIGHTS });
    evaluator.score(current);
    const ana = nurses.find((n) => n.contractedHoursPerPeriod > 0)!;
    for (const key of Object.keys(current.get(ana.id)!) as (keyof BurdenCounters)[]) {
      const world = new Map(current);
      const was = current.get(ana.id)!;
      world.set(ana.id, {
        ...was,
        [key]: key === 'preferenceHitRate' ? 1 - was[key] : was[key] + 1,
      });
      const lean = evaluator.score(world);
      const full = oracle(nurses, history, world);
      expect(lean.mean, key).toBe(full.mean);
      expect(lean.byNurse.get(ana.id), key).toBe(full.byNurse.get(ana.id));
    }
  });

  it('counts a nurse missing from the period counters as having worked nothing', () => {
    const { nurses, history, current } = randomUnit(7);
    const partial = new Map([...current].slice(1));
    const evaluator = new FairnessEvaluator({ nurses, history, weights: DEFAULT_FAIRNESS_WEIGHTS });
    const lean = evaluator.score(partial);
    const full = oracle(nurses, history, partial);
    expect(lean.mean).toBe(full.mean);
    expect([...lean.byNurse]).toEqual([...full.byNurse]);
  });
});
