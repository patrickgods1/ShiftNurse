import { describe, expect, it } from 'vitest';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { computeBurden } from './burden.js';
import { distributionStats, gini, unitDistribution } from './distribution.js';
import { EMPTY_COUNTERS, type NurseFairnessScore } from './types.js';

describe('gini', () => {
  it('is 0 when everyone carries the same amount: [1,1,1,1]', () => {
    expect(gini([1, 1, 1, 1])).toBeCloseTo(0, 9);
  });

  it('is 0.75 when one of four carries the entire burden: [0,0,0,4]', () => {
    expect(gini([0, 0, 0, 4])).toBeCloseTo(0.75, 9);
  });

  it('is 0.25 for a mild, evenly-graduated spread: [1,2,3,4]', () => {
    expect(gini([1, 2, 3, 4])).toBeCloseTo(0.25, 9);
  });

  it('is 0 for an empty list — nothing to be unequal about', () => {
    expect(gini([])).toBe(0);
  });
});

describe('distributionStats', () => {
  it('reports zeros across the board for an empty set rather than NaN', () => {
    expect(distributionStats([])).toEqual({
      gini: 0,
      min: 0,
      max: 0,
      mean: 0,
      spread: 0,
      count: 0,
    });
  });

  it('computes min, max, mean and spread from a hand-checked set', () => {
    const stats = distributionStats([2, 4, 6]);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(6);
    expect(stats.mean).toBeCloseTo(4, 9);
    expect(stats.spread).toBe(4);
    expect(stats.count).toBe(3);
  });
});

describe('unit distribution', () => {
  it('reads burden rates per share weight so a 0.5 FTE with half the nights looks even, not under-burdened', () => {
    resetFixtureCounters();
    const fullTime = makeNurse({ contractedHoursPerPeriod: 72 });
    const halfTime = makeNurse({ contractedHoursPerPeriod: 36 });
    const current = new Map([
      [fullTime.id, { ...EMPTY_COUNTERS, nightShifts: 8 }],
      [halfTime.id, { ...EMPTY_COUNTERS, nightShifts: 4 }],
    ]);
    const burden = computeBurden([fullTime, halfTime], [], {}, current);
    const scores: NurseFairnessScore[] = [
      {
        nurseId: fullTime.id,
        score: 100,
        components: [],
        seniorityMultiplier: 1,
        burdenIndex: burden.byNurse.get(fullTime.id)!.index,
        comparable: true,
      },
      {
        nurseId: halfTime.id,
        score: 100,
        components: [],
        seniorityMultiplier: 1,
        burdenIndex: burden.byNurse.get(halfTime.id)!.index,
        comparable: true,
      },
    ];
    const distribution = unitDistribution(burden, scores);
    // 8 nights / 72h = 4 nights / 36h = 0.1111 each — identical rates, zero inequality.
    expect(distribution.components.nights.mean).toBeCloseTo(8 / 72, 9);
    expect(distribution.components.nights.gini).toBeCloseTo(0, 9);
  });

  it('excludes a non-comparable nurse from the score distribution entirely', () => {
    resetFixtureCounters();
    const staffed = makeNurse({ contractedHoursPerPeriod: 72 });
    const perDiem = makeNurse({ contractedHoursPerPeriod: 0 });
    const burden = computeBurden([staffed, perDiem], []);
    const scores: NurseFairnessScore[] = [
      {
        nurseId: staffed.id,
        score: 80,
        components: [],
        seniorityMultiplier: 1,
        burdenIndex: 0,
        comparable: true,
      },
      {
        nurseId: perDiem.id,
        score: 100,
        components: [],
        seniorityMultiplier: 1,
        burdenIndex: 0,
        comparable: false,
      },
    ];
    const distribution = unitDistribution(burden, scores);
    expect(distribution.score.count).toBe(1);
    expect(distribution.score.mean).toBe(80);
  });
});
