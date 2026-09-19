import { describe, expect, it } from 'vitest';
import type { Id } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { componentScore, scoreFairness } from './score.js';
import { type BurdenCounters, DEFAULT_FAIRNESS_WEIGHTS, EMPTY_COUNTERS } from './types.js';

describe('componentScore', () => {
  it('scores at-or-under fair share as a perfect 100', () => {
    expect(componentScore(0)).toBe(100);
    expect(componentScore(-0.3)).toBe(100); // under-share is favourable, clamps to perfect
  });

  it('scores exactly double the fair share as 0', () => {
    expect(componentScore(1)).toBe(0);
  });

  it('scores a 50% overage as a midpoint 50', () => {
    expect(componentScore(0.5)).toBe(50);
  });

  it('never goes negative even far past double the fair share', () => {
    expect(componentScore(2)).toBe(0);
  });
});

describe('scoreFairness', () => {
  it('gives a nurse sitting exactly at every fair share a perfect composite score', () => {
    resetFixtureCounters();
    const a = makeNurse({ contractedHoursPerPeriod: 72 });
    const b = makeNurse({ contractedHoursPerPeriod: 72 });
    // Identical counters on identical contracted hours -> both exactly at fair share on every
    // burden component; no preference or time-off rows means those default to neutral (0) too.
    const current = new Map<Id, BurdenCounters>([
      [a.id, { ...EMPTY_COUNTERS, nightShifts: 4, weekendsWorked: 2 }],
      [b.id, { ...EMPTY_COUNTERS, nightShifts: 4, weekendsWorked: 2 }],
    ]);
    const report = scoreFairness({ nurses: [a, b], current, history: [], preferences: [] });
    const scoreA = report.scores.find((s) => s.nurseId === a.id)!;
    expect(scoreA.score).toBe(100);
    expect(scoreA.comparable).toBe(true);
  });

  it('drops a component from the composite entirely when its weight is zeroed out', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    // This nurse carried double the team's on-call load but nothing else is off-share, and a
    // second nurse anchors the fair share at a nonzero baseline.
    const peer = makeNurse({ contractedHoursPerPeriod: 72 });
    const current = new Map<Id, BurdenCounters>([
      [nurse.id, { ...EMPTY_COUNTERS, onCallShifts: 8 }],
      [peer.id, { ...EMPTY_COUNTERS, onCallShifts: 0 }],
    ]);
    const weightsWithOnCall = { ...DEFAULT_FAIRNESS_WEIGHTS, onCall: 1 };
    const weightsWithoutOnCall = { ...DEFAULT_FAIRNESS_WEIGHTS, onCall: 0 };
    const withOnCall = scoreFairness({
      nurses: [nurse, peer],
      current,
      history: [],
      preferences: [],
      weights: weightsWithOnCall,
    });
    const withoutOnCall = scoreFairness({
      nurses: [nurse, peer],
      current,
      history: [],
      preferences: [],
      weights: weightsWithoutOnCall,
    });
    const scoreWith = withOnCall.scores.find((s) => s.nurseId === nurse.id)!;
    const scoreWithout = withoutOnCall.scores.find((s) => s.nurseId === nurse.id)!;
    // Zeroing the weight removes the over-share on-call component from the average entirely,
    // so the nurse who was dragged down by it scores strictly higher once it's gone.
    expect(scoreWithout.score).toBeGreaterThan(scoreWith.score);
    expect(scoreWithout.components.find((c) => c.component === 'onCall')!.weight).toBe(0);
  });

  it("charges more composite points for a senior nurse's unmet preferences than an identical junior miss", () => {
    resetFixtureCounters();
    const senior = makeNurse({
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2010-01-01'),
    });
    const junior = makeNurse({
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
    });
    // Same counters for both -- at fair share on every burden, but both carry the same
    // below-team preference hit rate via history, so only seniority should separate them.
    const history = [
      {
        id: 'ledger-senior',
        nurseId: senior.id,
        periodId: 'p1',
        periodStart: isoDate('2026-08-01'),
        ...EMPTY_COUNTERS,
        preferenceHitRate: 0.4,
      },
      {
        id: 'ledger-junior',
        nurseId: junior.id,
        periodId: 'p1',
        periodStart: isoDate('2026-08-01'),
        ...EMPTY_COUNTERS,
        preferenceHitRate: 0.4,
      },
      // A third nurse with a perfect rate pulls the team average above both, so deviation > 0.
      {
        id: 'ledger-peer',
        nurseId: 'peer-anchor',
        periodId: 'p1',
        periodStart: isoDate('2026-08-01'),
        ...EMPTY_COUNTERS,
        preferenceHitRate: 1.0,
      },
    ];
    const peerAnchor = makeNurse({ id: 'peer-anchor', contractedHoursPerPeriod: 72 });
    const report = scoreFairness({
      nurses: [senior, junior, peerAnchor],
      current: new Map(),
      history,
      preferences: [],
    });
    const seniorScore = report.scores.find((s) => s.nurseId === senior.id)!;
    const juniorScore = report.scores.find((s) => s.nurseId === junior.id)!;
    const seniorPref = seniorScore.components.find((c) => c.component === 'preferences')!;
    const juniorPref = juniorScore.components.find((c) => c.component === 'preferences')!;
    expect(seniorPref.deviation).toBeCloseTo(juniorPref.deviation, 9); // same underlying gap
    expect(seniorPref.weight).toBeGreaterThan(juniorPref.weight); // seniority scales the weight
    expect(seniorScore.score).toBeLessThan(juniorScore.score); // costs more in the composite
  });
});

// ---------------------------------------------------------------------------
// Monotonicity property test
// ---------------------------------------------------------------------------

/** Tiny deterministic LCG so the property test is reproducible without depending on
 * Math.random or any external seeded-RNG package. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xffffffff;
  };
}

function randomInt(rng: () => number, max: number): number {
  return Math.floor(rng() * (max + 1));
}

type BurdenBump =
  | 'nights'
  | 'weekends'
  | 'holidays'
  | 'onCall'
  | 'undesirable'
  | 'overtime'
  | 'requestsDenied'
  | 'preferenceHitRate';

const BUMPS: BurdenBump[] = [
  'nights',
  'weekends',
  'holidays',
  'onCall',
  'undesirable',
  'overtime',
  'requestsDenied',
  'preferenceHitRate',
];

function applyBump(counters: BurdenCounters, bump: BurdenBump): BurdenCounters {
  const next = { ...counters };
  switch (bump) {
    case 'nights':
      next.nightShifts += 1;
      next.totalHours += 12;
      break;
    case 'weekends':
      next.weekendsWorked += 1;
      break;
    case 'holidays':
      next.holidaysWorked += 1;
      break;
    case 'onCall':
      next.onCallShifts += 1;
      break;
    case 'undesirable':
      next.undesirableShifts += 1;
      break;
    case 'overtime':
      next.overtimeHours += 4;
      break;
    case 'requestsDenied':
      next.requestsDenied += 1;
      break;
    case 'preferenceHitRate':
      next.preferenceHitRate = Math.max(0, next.preferenceHitRate - 0.1);
      break;
  }
  return next;
}

/** Build a random-ish roster: 4-7 nurses, each with modest, non-degenerate current-period
 * counters, so no single nurse can dominate a pooled team rate (see burden.ts's time-off
 * rate) and swamp the property with an artifact of extreme concentration rather than a real
 * fairness regression. */
function randomScenario(rng: () => number) {
  resetFixtureCounters();
  const nurseCount = 4 + randomInt(rng, 3);
  const nurses = Array.from({ length: nurseCount }, () =>
    makeNurse({ contractedHoursPerPeriod: 60 + randomInt(rng, 5) * 12 }),
  );
  const current = new Map<Id, BurdenCounters>();
  for (const nurse of nurses) {
    const approved = 1 + randomInt(rng, 4);
    const denied = randomInt(rng, 3);
    current.set(nurse.id, {
      ...EMPTY_COUNTERS,
      nightShifts: randomInt(rng, 6),
      weekendsWorked: randomInt(rng, 4),
      holidaysWorked: randomInt(rng, 2),
      onCallShifts: randomInt(rng, 3),
      undesirableShifts: randomInt(rng, 3),
      overtimeHours: randomInt(rng, 10),
      requestsApproved: approved,
      requestsDenied: denied,
      totalHours: 40 + randomInt(rng, 40),
      preferenceHitRate: 0.4 + rng() * 0.5,
    });
  }
  return { nurses, current };
}

describe('fairness score monotonicity', () => {
  it('never rewards a nurse with a higher score after their burden gets strictly worse', () => {
    const trials = 30;
    for (let seed = 1; seed <= trials; seed++) {
      const rng = makeRng(seed * 2_654_435_761);
      const { nurses, current } = randomScenario(rng);
      const target = nurses[randomInt(rng, nurses.length - 1)]!;
      const bump = BUMPS[randomInt(rng, BUMPS.length - 1)]!;

      const before = scoreFairness({ nurses, current, history: [], preferences: [] });
      const bumpedCurrent = new Map(current);
      bumpedCurrent.set(target.id, applyBump(current.get(target.id)!, bump));
      const after = scoreFairness({ nurses, current: bumpedCurrent, history: [], preferences: [] });

      const scoreBefore = before.scores.find((s) => s.nurseId === target.id)!.score;
      const scoreAfter = after.scores.find((s) => s.nurseId === target.id)!.score;

      expect(scoreAfter).toBeLessThanOrEqual(scoreBefore + 1e-9);
    }
  });
});
