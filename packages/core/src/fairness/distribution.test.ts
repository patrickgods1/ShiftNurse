import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { computeBurden } from './burden.js';
import { distributionStats, gini, unitDistribution } from './distribution.js';
import {
  type BurdenReport,
  type BurdenScope,
  EMPTY_COUNTERS,
  type NurseFairnessScore,
} from './types.js';

const SCOPE: BurdenScope = { asOf: isoDate('2026-07-05'), periodDays: 14, payPeriodDays: 14 };
const FORTNIGHT = { periodDays: 14, availableDays: 14 };

function scoresFor(burden: BurdenReport, ids: readonly string[]): NurseFairnessScore[] {
  return ids.map((nurseId) => ({
    nurseId,
    score: 100,
    components: [],
    seniorityMultiplier: 1,
    occurrences: { nights: [], weekends: [], holidays: [] },
    burdenIndex: burden.byNurse.get(nurseId)!.index,
    comparable: burden.byNurse.get(nurseId)!.comparable,
  }));
}

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
  it("shows each burden as a share of the nurse's fair share", () => {
    resetFixtureCounters();
    const fullTime = makeNurse({ contractedHoursPerPeriod: 72 });
    const halfTime = makeNurse({ contractedHoursPerPeriod: 36 });
    const nightsFor = (full: number, half: number) => {
      const current = new Map([
        [fullTime.id, { ...EMPTY_COUNTERS, ...FORTNIGHT, nightShifts: full }],
        [halfTime.id, { ...EMPTY_COUNTERS, ...FORTNIGHT, nightShifts: half }],
      ]);
      const burden = computeBurden([fullTime, halfTime], [], SCOPE, {}, current);
      return unitDistribution(burden, scoresFor(burden, [fullTime.id, halfTime.id]));
    };

    // 8 + 4 = 12 nights split 72:36 is a fair share of 8 and 4: each carried exactly hers.
    const even = nightsFor(8, 4);
    expect(even.components.nights.min).toBeCloseTo(1, 9);
    expect(even.components.nights.max).toBeCloseTo(1, 9);
    expect(even.components.nights.gini).toBeCloseTo(0, 9);
    // Nobody carried a weekend, so each is at her (zero) share of them: 1.00, not 0.
    expect(even.components.weekends.mean).toBe(1);
    expect(even.components.weekends.count).toBe(2);

    // 12 + 2 = 14 nights split 72:36 is 9.333 and 4.667: 12 / 9.333 = 1.2857, 2 / 4.667 = 0.4286.
    const lopsided = nightsFor(12, 2);
    expect(lopsided.components.nights.max).toBeCloseTo(1.2857, 4);
    expect(lopsided.components.nights.min).toBeCloseTo(0.4286, 4);
  });

  it('leaves a nurse with no fair share out of the burden rates', () => {
    resetFixtureCounters();
    const staffed = makeNurse({ contractedHoursPerPeriod: 72 });
    const perDiem = makeNurse({ contractedHoursPerPeriod: 0 });
    // The per-diem nurse has no contract and no hours on record, so nothing to divide by.
    const current = new Map([
      [staffed.id, { ...EMPTY_COUNTERS, ...FORTNIGHT, nightShifts: 3 }],
      [perDiem.id, { ...EMPTY_COUNTERS, ...FORTNIGHT, nightShifts: 2 }],
    ]);
    const burden = computeBurden([staffed, perDiem], [], SCOPE, {}, current);
    const distribution = unitDistribution(burden, scoresFor(burden, [staffed.id, perDiem.id]));
    // Only the staffed nurse is compared, and the team total is hers alone: 3 / 3 = 1.
    expect(distribution.components.nights.count).toBe(1);
    expect(distribution.components.nights.mean).toBeCloseTo(1, 9);
  });

  it('excludes a non-comparable nurse from the score distribution entirely', () => {
    resetFixtureCounters();
    const staffed = makeNurse({ contractedHoursPerPeriod: 72 });
    const perDiem = makeNurse({ contractedHoursPerPeriod: 0 });
    // Both on the period being scored with nothing worked: the staffed nurse is there all of it.
    const burden = computeBurden([staffed, perDiem], [], SCOPE, {}, new Map());
    const scores: NurseFairnessScore[] = [
      {
        nurseId: staffed.id,
        score: 80,
        components: [],
        seniorityMultiplier: 1,
        occurrences: { nights: [], weekends: [], holidays: [] },
        burdenIndex: 0,
        comparable: true,
      },
      {
        nurseId: perDiem.id,
        score: 100,
        components: [],
        seniorityMultiplier: 1,
        occurrences: { nights: [], weekends: [], holidays: [] },
        burdenIndex: 0,
        comparable: false,
      },
    ];
    const distribution = unitDistribution(burden, scores);
    expect(distribution.score.count).toBe(1);
    expect(distribution.score.mean).toBe(80);
  });
});
