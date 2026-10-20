import { describe, expect, it } from 'vitest';
import type { FairnessLedgerEntry, Id } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { componentScore, scoreFairness } from './score.js';
import {
  type BurdenCounters,
  type BurdenScope,
  DEFAULT_FAIRNESS_WEIGHTS,
  EMPTY_COUNTERS,
  type FairnessComponent,
} from './types.js';

const SCOPE: BurdenScope = { asOf: isoDate('2026-10-04'), periodDays: 14, payPeriodDays: 14 };

/** This period's counters for a fully available fortnight. */
function now(overrides: Partial<BurdenCounters> = {}): BurdenCounters {
  return { ...EMPTY_COUNTERS, periodDays: 14, availableDays: 14, ...overrides };
}

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
      [a.id, now({ nightShifts: 4, weekendsWorked: 2 })],
      [b.id, now({ nightShifts: 4, weekendsWorked: 2 })],
    ]);
    const report = scoreFairness({
      nurses: [a, b],
      current,
      history: [],
      scope: SCOPE,
      preferences: [],
    });
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
      [nurse.id, now({ onCallShifts: 8 })],
      [peer.id, now({ onCallShifts: 0 })],
    ]);
    const weightsWithOnCall = { ...DEFAULT_FAIRNESS_WEIGHTS, onCall: 1 };
    const weightsWithoutOnCall = { ...DEFAULT_FAIRNESS_WEIGHTS, onCall: 0 };
    const withOnCall = scoreFairness({
      nurses: [nurse, peer],
      current,
      history: [],
      scope: SCOPE,
      preferences: [],
      weights: weightsWithOnCall,
    });
    const withoutOnCall = scoreFairness({
      nurses: [nurse, peer],
      current,
      history: [],
      scope: SCOPE,
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

  it('reads a senior and a junior nurse with the same burden as equally fair', () => {
    // A carries 6 nights, B 2, C 4 on identical 72h contracts with no history: 12 nights over
    // three equal fair weights is a fair share of 4 each, so A is +50% (component 50), B is
    // under share and C is exactly at it. Everyone avoids a shift type nobody worked, so every
    // hit rate is 1 and the preference component is a perfect 100. Nobody carried weekends,
    // holidays, on-call, undesirable shifts or overtime, and nobody had a time-off decision.
    //
    // A's composite with the default weights and no seniority term, in summation order:
    //   (2×50 + 3×100 + 3×100 + 1.5×100 + 2×100 + 0.5×100 + 2×100 + 1.5×100) / 15.5
    //   = 1450 / 15.5 = 93.548… → 93.5
    // With the old 1.5× seniority on A's preference weight it read 1550 / 16.5 = 93.9 instead.
    const build = (aSeniority: string, bSeniority: string) => {
      resetFixtureCounters();
      const a = makeNurse({ contractedHoursPerPeriod: 72, seniorityDate: isoDate(aSeniority) });
      const b = makeNurse({ contractedHoursPerPeriod: 72, seniorityDate: isoDate(bSeniority) });
      const c = makeNurse({ contractedHoursPerPeriod: 72, seniorityDate: isoDate('2015-01-01') });
      const current = new Map<Id, BurdenCounters>([
        [a.id, now({ nightShifts: 6, preferenceHitRate: 1 })],
        [b.id, now({ nightShifts: 2, preferenceHitRate: 1 })],
        [c.id, now({ nightShifts: 4, preferenceHitRate: 1 })],
      ]);
      const report = scoreFairness({
        nurses: [a, b, c],
        current,
        history: [],
        scope: SCOPE,
        preferences: [],
      });
      return report.scores.find((s) => s.nurseId === a.id)!;
    };
    const aMostSenior = build('2010-01-01', '2020-01-01');
    const aMostJunior = build('2020-01-01', '2010-01-01');

    // The table still shows how senior she is; it just no longer moves her score.
    expect(aMostSenior.seniorityMultiplier).toBe(1.5);
    expect(aMostJunior.seniorityMultiplier).toBe(1);
    expect(aMostSenior.score).toBe(93.5);
    expect(aMostJunior.score).toBe(93.5);
    const prefWeight = (s: typeof aMostSenior) =>
      s.components.find((c) => c.component === 'preferences')!.weight;
    expect(prefWeight(aMostSenior)).toBe(DEFAULT_FAIRNESS_WEIGHTS.preferences);
    expect(prefWeight(aMostJunior)).toBe(DEFAULT_FAIRNESS_WEIGHTS.preferences);
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

/** Which deviation a bump must not lower. */
const BUMPED_COMPONENT: Record<BurdenBump, FairnessComponent> = {
  nights: 'nights',
  weekends: 'weekends',
  holidays: 'holidays',
  onCall: 'onCall',
  undesirable: 'undesirable',
  overtime: 'overtime',
  requestsDenied: 'timeOff',
  preferenceHitRate: 'preferences',
};

/** Modest, non-degenerate counters, so no single nurse can dominate a pooled team rate (see
 * burden.ts's time-off rate) and swamp the property with an artifact of extreme concentration
 * rather than a real fairness regression. */
function randomCounters(
  rng: () => number,
  periodDays: number,
): Omit<BurdenCounters, 'availableDays'> {
  return {
    ...EMPTY_COUNTERS,
    periodDays,
    nightShifts: randomInt(rng, 6),
    weekendsWorked: randomInt(rng, 4),
    holidaysWorked: randomInt(rng, 2),
    onCallShifts: randomInt(rng, 3),
    undesirableShifts: randomInt(rng, 3),
    overtimeHours: randomInt(rng, 10),
    requestsApproved: 1 + randomInt(rng, 4),
    requestsDenied: randomInt(rng, 3),
    totalHours: 40 + randomInt(rng, 40),
    preferenceHitRate: 0.4 + rng() * 0.5,
  };
}

/** A random roster of 4-7 nurses, each with 0-13 ledger rows from the 400 days before `asOf`
 * (fortnights and six-week periods, any availability) and a random availability now. */
function randomScenario(rng: () => number) {
  resetFixtureCounters();
  const nurseCount = 4 + randomInt(rng, 3);
  const nurses = Array.from({ length: nurseCount }, () =>
    makeNurse({ contractedHoursPerPeriod: 60 + randomInt(rng, 5) * 12 }),
  );
  const history: FairnessLedgerEntry[] = [];
  const current = new Map<Id, BurdenCounters>();
  for (const nurse of nurses) {
    const rows = randomInt(rng, 13);
    for (let r = 0; r < rows; r++) {
      const periodDays = rng() < 0.5 ? 14 : 42;
      history.push({
        id: `${nurse.id}-h${r}`,
        nurseId: nurse.id,
        periodId: `period-${r}`,
        periodStart: addDays(SCOPE.asOf, -(1 + randomInt(rng, 399))),
        ...randomCounters(rng, periodDays),
        availableDays: randomInt(rng, periodDays),
      });
    }
    current.set(nurse.id, {
      ...randomCounters(rng, SCOPE.periodDays),
      availableDays: randomInt(rng, SCOPE.periodDays),
    });
  }
  return { nurses, history, current };
}

describe('fairness score monotonicity', () => {
  it('never rewards a nurse with a higher score after their burden gets strictly worse', () => {
    const trials = 200;
    for (let seed = 1; seed <= trials; seed++) {
      const rng = makeRng(seed * 2_654_435_761);
      const { nurses, history, current } = randomScenario(rng);
      const target = nurses[randomInt(rng, nurses.length - 1)]!;
      const bump = BUMPS[randomInt(rng, BUMPS.length - 1)]!;
      const score = (counters: ReadonlyMap<Id, BurdenCounters>) =>
        scoreFairness({ nurses, current: counters, history, scope: SCOPE, preferences: [] });

      const before = score(current);
      const bumpedCurrent = new Map(current);
      bumpedCurrent.set(target.id, applyBump(current.get(target.id)!, bump));
      const after = score(bumpedCurrent);

      const mine = (report: ReturnType<typeof score>) =>
        report.scores.find((s) => s.nurseId === target.id)!;
      const component = BUMPED_COMPONENT[bump];
      const deviation = (report: ReturnType<typeof score>) =>
        mine(report).components.find((c) => c.component === component)!.deviation;

      expect(mine(after).score, `seed ${seed} ${bump}`).toBeLessThanOrEqual(
        mine(before).score + 1e-9,
      );
      expect(deviation(after), `seed ${seed} ${bump}`).toBeGreaterThanOrEqual(
        deviation(before) - 1e-9,
      );
    }
  });
});

describe('occurrences on the report', () => {
  it("carries the dates behind each nurse's burden, and empty lists when none were given", () => {
    resetFixtureCounters();
    const a = makeNurse({ contractedHoursPerPeriod: 72 });
    const b = makeNurse({ contractedHoursPerPeriod: 72 });
    const occurrences = new Map([
      [a.id, { nights: [isoDate('2026-10-03')], weekends: [isoDate('2026-10-03')], holidays: [] }],
    ]);
    const report = scoreFairness({
      nurses: [a, b],
      current: new Map(),
      history: [],
      scope: SCOPE,
      preferences: [],
      occurrences,
    });
    expect(report.scores.find((s) => s.nurseId === a.id)?.occurrences).toEqual({
      nights: ['2026-10-03'],
      weekends: ['2026-10-03'],
      holidays: [],
    });
    expect(report.scores.find((s) => s.nurseId === b.id)?.occurrences).toEqual({
      nights: [],
      weekends: [],
      holidays: [],
    });
  });
});
