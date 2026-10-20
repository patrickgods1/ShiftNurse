import { describe, expect, it } from 'vitest';
import type { FairnessLedgerEntry, Id, Nurse } from '../domain/entities.js';
import { addDays, type IsoDate, isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { computeBurden } from './burden.js';
import {
  type BurdenCounters,
  type BurdenScope,
  DEFAULT_FAIRNESS_WEIGHTS,
  EMPTY_COUNTERS,
  FAIRNESS_COMPONENTS,
  type FairnessWeights,
} from './types.js';

const AS_OF = isoDate('2026-07-05');
const SCOPE: BurdenScope = { asOf: AS_OF, periodDays: 14, payPeriodDays: 14 };

let ledgerCounter = 0;

/**
 * One ledger row starting `daysBefore` days before `asOf`: a fully available fortnight unless the
 * test says otherwise, so a test only states what it cares about.
 */
function row(
  nurseId: string,
  daysBefore: number,
  overrides: Partial<FairnessLedgerEntry> = {},
  asOf: IsoDate = AS_OF,
): FairnessLedgerEntry {
  ledgerCounter++;
  return {
    id: `ledger-${ledgerCounter}`,
    nurseId,
    periodId: overrides.periodId ?? `period-${ledgerCounter}`,
    periodStart: addDays(asOf, -daysBefore),
    ...EMPTY_COUNTERS,
    periodDays: 14,
    availableDays: 14,
    ...overrides,
  };
}

/** This period's counters for a fully available fortnight. */
function now(overrides: Partial<BurdenCounters> = {}): BurdenCounters {
  return { ...EMPTY_COUNTERS, periodDays: 14, availableDays: 14, ...overrides };
}

/** Only the named components weigh anything. */
function onlyWeights(weights: Partial<FairnessWeights>): FairnessWeights {
  const out = {} as FairnessWeights;
  for (const c of FAIRNESS_COMPONENTS) out[c] = weights[c] ?? 0;
  return out;
}

/** 0.5 ** (age / 180): the weight of a row whose midpoint is `age` days before asOf. */
const HALF_LIFE = 180;
const w = (age: number) => 0.5 ** (age / HALF_LIFE);

describe('carried burden and deviation from fair share', () => {
  it('a nurse who carried 12 nights against a peer with 4 is 50% over share; the peer is 50% under', () => {
    resetFixtureCounters();
    const a = makeNurse({ contractedHoursPerPeriod: 72 });
    const b = makeNurse({ contractedHoursPerPeriod: 72 });
    const current = new Map([
      [a.id, now({ nightShifts: 12 })],
      [b.id, now({ nightShifts: 4 })],
    ]);
    const report = computeBurden([a, b], [], SCOPE, {}, current);
    // Team total 16 nights split by equal 72h shares -> fair share 8 each.
    expect(report.byNurse.get(a.id)!.deviation.nights).toBeCloseTo(0.5, 6);
    expect(report.byNurse.get(b.id)!.deviation.nights).toBeCloseTo(-0.5, 6);
    expect(report.ranked[0]!.nurseId).toBe(a.id); // most owed relief ranks first
  });

  it('a 0.5 FTE nurse who worked half the nights of a full-timer is right at their share', () => {
    resetFixtureCounters();
    const fullTime = makeNurse({ contractedHoursPerPeriod: 72 });
    const halfTime = makeNurse({ contractedHoursPerPeriod: 36 });
    const current = new Map([
      [fullTime.id, now({ nightShifts: 8 })],
      [halfTime.id, now({ nightShifts: 4 })],
    ]);
    const report = computeBurden([fullTime, halfTime], [], SCOPE, {}, current);
    expect(report.byNurse.get(fullTime.id)!.deviation.nights).toBeCloseTo(0, 9);
    expect(report.byNurse.get(halfTime.id)!.deviation.nights).toBeCloseTo(0, 9);
  });

  it("halves a period's weight every 180 days", () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    // 2025-12-30 + 7 = 2026-01-06, 180 days before 2026-07-05; 2025-07-03 + 7 is 360 days before.
    const history = [
      row(nurse.id, 0, { periodStart: isoDate('2025-12-30'), nightShifts: 8 }),
      row(nurse.id, 0, { periodStart: isoDate('2025-07-03'), nightShifts: 8 }),
    ];
    const report = computeBurden([nurse], history, SCOPE);
    // 8 × 0.5 + 8 × 0.25 = 6.
    expect(report.byNurse.get(nurse.id)!.carried.nightShifts).toBeCloseTo(6, 9);
  });

  it('forgets a period more than a year old', () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    // Midpoints 365 and 366 days before 2026-07-05: the first is in the year, the second not.
    const history = [
      row(nurse.id, 0, { periodStart: isoDate('2025-06-28'), nightShifts: 4 }),
      row(nurse.id, 0, { periodStart: isoDate('2025-06-27'), nightShifts: 4 }),
    ];
    const report = computeBurden([nurse], history, SCOPE, {
      halfLifeDays: Number.POSITIVE_INFINITY,
    });
    expect(report.byNurse.get(nurse.id)!.carried.nightShifts).toBe(4);
    expect(report.byNurse.get(nurse.id)!.periodsInWindow).toBe(1);
  });

  it('a per-diem nurse with no contracted hours and no history cannot be compared to the team', () => {
    resetFixtureCounters();
    const perDiem = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const staffed = makeNurse({ contractedHoursPerPeriod: 72 });
    const current = new Map([[staffed.id, now({ nightShifts: 4 })]]);
    const report = computeBurden([perDiem, staffed], [], SCOPE, {}, current);
    const nb = report.byNurse.get(perDiem.id)!;
    expect(nb.shareWeight).toBe(0);
    expect(nb.comparable).toBe(false);
    expect(nb.index).toBe(0);
    for (const value of Object.values(nb.deviation)) {
      expect(value).toBe(0);
    }
  });

  it('a per-diem nurse with a history of worked hours gets a fair share from her hours per pay period', () => {
    resetFixtureCounters();
    const perDiem = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const history = [
      row(perDiem.id, 14, { totalHours: 20 }),
      row(perDiem.id, 28, { totalHours: 40 }),
    ];
    const report = computeBurden([perDiem], history, SCOPE, {
      halfLifeDays: Number.POSITIVE_INFINITY,
    });
    // 14 × (20 + 40) / (14 + 14) = 30 hours per pay period available.
    expect(report.byNurse.get(perDiem.id)!.shareWeight).toBeCloseTo(30, 9);
  });

  it('a denied time-off request pulls a nurse behind the team and pushes their deviation positive', () => {
    resetFixtureCounters();
    const denied = makeNurse();
    const approved = makeNurse();
    const current = new Map([
      [denied.id, now({ requestsApproved: 1, requestsDenied: 1 })], // 50%
      [approved.id, now({ requestsApproved: 2, requestsDenied: 0 })], // 100%
    ]);
    const report = computeBurden([denied, approved], [], SCOPE, {}, current);
    // Team rate = (1+2)/(2+2) = 0.75. denied's own rate = 0.5, so 0.75 - 0.5 = +0.25.
    expect(report.byNurse.get(denied.id)!.deviation.timeOff).toBeCloseTo(0.25, 9);
    expect(report.byNurse.get(approved.id)!.deviation.timeOff).toBeCloseTo(-0.25, 9);
  });

  it('preference hit rate is carried as a weighted mean, not summed across periods', () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    // The second row is one half-life older than the first, so it weighs half as much.
    const history = [
      row(nurse.id, 14, { preferenceHitRate: 1.0 }),
      row(nurse.id, 14 + HALF_LIFE, { preferenceHitRate: 0.5 }),
    ];
    const report = computeBurden([nurse], history, SCOPE);
    // Weighted mean: (1.0*1 + 0.5*0.5) / (1 + 0.5) = 1.25 / 1.5 = 0.8333...
    // (If this were a sum it would be 1.25, which is not even a valid rate.)
    expect(report.byNurse.get(nurse.id)!.carried.preferenceHitRate).toBeCloseTo(1.25 / 1.5, 9);
  });
});

describe('burden as a rate per day available, decayed by age', () => {
  it("does not make a new hire repay the team's history: a veteran and a hire at the same rate both read at share", () => {
    resetFixtureCounters();
    const veteran = makeNurse({ contractedHoursPerPeriod: 72 });
    const hire = makeNurse({ contractedHoursPerPeriod: 72 });
    const history = Array.from({ length: 13 }, (_, k) =>
      row(veteran.id, 14 * (k + 1), { nightShifts: 3 }),
    );
    const current = new Map([
      [veteran.id, now({ nightShifts: 3 })],
      [hire.id, now({ nightShifts: 3 })],
    ]);
    const report = computeBurden([veteran, hire], history, SCOPE, {}, current);
    // Both carry 3 nights per pay period available, so the team rate is each nurse's rate. The
    // veteran's fair weight round2(72 × 10.34449) = 744.80 is the only error (~3e-6), hence 4 dp.
    expect(report.byNurse.get(veteran.id)!.deviation.nights).toBeCloseTo(0, 4);
    expect(report.byNurse.get(hire.id)!.deviation.nights).toBeCloseTo(0, 4);
    expect(report.byNurse.get(veteran.id)!.fairWeight).toBe(744.8);
  });

  it('weighs one prior period of heavy nights against the veteran, not the hire', () => {
    resetFixtureCounters();
    const veteran = makeNurse({ contractedHoursPerPeriod: 72 });
    const hire = makeNurse({ contractedHoursPerPeriod: 72 });
    const history = [row(veteran.id, 14, { nightShifts: 6 })];
    const current = new Map([
      [veteran.id, now({ nightShifts: 3 })],
      [hire.id, now({ nightShifts: 3 })],
    ]);
    const report = computeBurden([veteran, hire], history, SCOPE, {}, current);
    // w = 0.5^(7/180) = 0.973404. Veteran carried 3 + 6w = 8.840426, exposure 1 + w = 1.973404,
    // fair weight round2(142.0851) = 142.09; hire carried 3, fair weight 72. Team 11.840426 over
    // 214.09: hire share 11.840426 × 72 / 214.09 = 3.982020, (3 − 3.982020)/3.982020 = −0.246614;
    // veteran share 11.840426 × 142.09 / 214.09 = 7.858406, deviation +0.124964.
    const vet = report.byNurse.get(veteran.id)!;
    const newbie = report.byNurse.get(hire.id)!;
    expect(vet.fairWeight).toBe(142.09);
    expect(newbie.fairWeight).toBe(72);
    expect(newbie.fairShare.nights).toBeCloseTo(3.98202, 4);
    expect(newbie.deviation.nights).toBeCloseTo(-0.246614, 4);
    expect(vet.fairShare.nights).toBeCloseTo(7.858406, 4);
    expect(vet.deviation.nights).toBeCloseTo(0.124964, 4);
  });

  it("does not let leave raise or lower a nurse's standing", () => {
    resetFixtureCounters();
    const nurses = [0, 1, 2, 3, 4].map((i) =>
      makeNurse({ id: `n${i}`, contractedHoursPerPeriod: [72, 72, 48, 36, 72][i]! }),
    );
    const history: FairnessLedgerEntry[] = [
      row('n0', 42, { nightShifts: 4, weekendsWorked: 2, preferenceHitRate: 0.7 }),
      row('n1', 14, { nightShifts: 2, holidaysWorked: 1, preferenceHitRate: 0.9 }),
      row('n1', 56, { nightShifts: 5, requestsDenied: 1, preferenceHitRate: 0.4 }),
      row('n2', 28, { nightShifts: 1, onCallShifts: 2, availableDays: 9 }),
      row('n3', 70, { weekendsWorked: 3, undesirableShifts: 2, requestsApproved: 2 }),
    ];
    const current = new Map<Id, BurdenCounters>([
      ['n0', now({ nightShifts: 2, weekendsWorked: 1, preferenceHitRate: 0.5 })],
      ['n1', now({ nightShifts: 4, overtimeHours: 6, preferenceHitRate: 0.8 })],
      ['n2', now({ nightShifts: 1, availableDays: 10, requestsApproved: 1 })],
      ['n3', now({ weekendsWorked: 2, holidaysWorked: 1, preferenceHitRate: 1 })],
      ['n4', now({ nightShifts: 3, requestsDenied: 1, preferenceHitRate: 0.6 })],
    ]);
    const before = computeBurden(nurses, history, SCOPE, {}, current);
    const onLeave = [
      ...history,
      row('n0', 14, { availableDays: 0 }),
      row('n0', 28, { availableDays: 0 }),
    ];
    const after = computeBurden(nurses, onLeave, SCOPE, {}, current);
    // A zero-availability row adds w × 0 to every sum, so nothing moves by a single bit.
    for (const nurse of nurses) {
      const a = after.byNurse.get(nurse.id)!;
      const b = before.byNurse.get(nurse.id)!;
      expect(a.deviation, nurse.id).toEqual(b.deviation);
      expect(a.index, nurse.id).toEqual(b.index);
    }
  });

  it('puts a nurse back from two periods of FMLA level with peers at the same rate', () => {
    resetFixtureCounters();
    const peer = makeNurse({ contractedHoursPerPeriod: 72 });
    const returner = makeNurse({ contractedHoursPerPeriod: 72 });
    const history = [
      row(peer.id, 14, { nightShifts: 3 }),
      row(peer.id, 28, { nightShifts: 3 }),
      row(returner.id, 14, { availableDays: 0 }),
      row(returner.id, 28, { availableDays: 0 }),
    ];
    const current = new Map([
      [peer.id, now({ nightShifts: 3 })],
      [returner.id, now({ nightShifts: 3 })],
    ]);
    const report = computeBurden([peer, returner], history, SCOPE, {}, current);
    // Both carried 3 nights per pay period available; only the hundredths rounding of the peer's
    // fair weight separates them (peer 2.3e-6, returner −6.7e-6). The old model read −0.440.
    expect(report.byNurse.get(peer.id)!.deviation.nights).toBeCloseTo(0, 4);
    expect(report.byNurse.get(returner.id)!.deviation.nights).toBeCloseTo(0, 4);
  });

  it('compares a per-diem nurse by her hours per pay period, not per schedule period', () => {
    resetFixtureCounters();
    const scope: BurdenScope = { asOf: AS_OF, periodDays: 42, payPeriodDays: 14 };
    const fullTime = makeNurse({ contractedHoursPerPeriod: 72 });
    const perDiem = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const sixWeeks = { periodDays: 42, availableDays: 42 };
    const history = [
      row(fullTime.id, 42, { ...sixWeeks, totalHours: 216, nightShifts: 6 }),
      row(perDiem.id, 42, { ...sixWeeks, totalHours: 72, nightShifts: 2 }),
    ];
    const current = new Map([
      [fullTime.id, now({ ...sixWeeks, totalHours: 216, nightShifts: 6 })],
      [perDiem.id, now({ ...sixWeeks, totalHours: 72, nightShifts: 2 })],
    ]);
    const report = computeBurden([fullTime, perDiem], history, scope, {}, current);
    // 14 × 72 / 42 = 24 hours per pay period; the row's age weight is on both sides and cancels.
    expect(report.byNurse.get(perDiem.id)!.shareWeight).toBeCloseTo(24, 9);
    // Both carry one night per 36 share-hours. Rounding leaves 6.0e-6 and −1.8e-5; the old
    // model, which gave the per diem 72 against the full-timer's 72, read −0.5 and +0.5.
    expect(report.byNurse.get(fullTime.id)!.deviation.nights).toBeCloseTo(0, 4);
    expect(report.byNurse.get(perDiem.id)!.deviation.nights).toBeCloseTo(0, 4);
  });

  it('counts three two-week imported periods the same as the six-week period they cover', () => {
    resetFixtureCounters();
    const a = makeNurse({ contractedHoursPerPeriod: 72 });
    const b = makeNurse({ contractedHoursPerPeriod: 72 });
    const history = [
      row(a.id, 42, { nightShifts: 2 }),
      row(a.id, 28, { nightShifts: 2 }),
      row(a.id, 14, { nightShifts: 2 }),
      row(b.id, 42, { periodDays: 42, availableDays: 42, nightShifts: 6 }),
    ];
    const current = new Map([
      [a.id, now({ nightShifts: 2 })],
      [b.id, now({ nightShifts: 2 })],
    ]);
    const report = computeBurden([a, b], history, SCOPE, {}, current);
    // A's history rate Σ w_k × 2 / Σ w_k × 14 = 1/7 a day; B's 6w / 42w = 1/7 a day. Equal rates,
    // so only the hundredths rounding of the fair weights is left (hence 4 dp).
    expect(report.byNurse.get(a.id)!.deviation.nights).toBeCloseTo(0, 4);
    expect(report.byNurse.get(b.id)!.deviation.nights).toBeCloseTo(0, 4);
  });

  it('scores the same history the same whenever it happened', () => {
    resetFixtureCounters();
    const nurses = [0, 1, 2].map((i) =>
      makeNurse({ id: `n${i}`, contractedHoursPerPeriod: [72, 48, 72][i]! }),
    );
    const later = addDays(AS_OF, 91);
    const build = (asOf: IsoDate) => [
      row('n0', 14, { periodId: 'p1', nightShifts: 4, preferenceHitRate: 0.6 }, asOf),
      row('n0', 100, { periodId: 'p2', weekendsWorked: 2, availableDays: 5 }, asOf),
      row('n1', 42, { periodId: 'p3', periodDays: 42, availableDays: 30, nightShifts: 5 }, asOf),
      row('n2', 200, { periodId: 'p4', holidaysWorked: 1, preferenceHitRate: 0.9 }, asOf),
    ];
    const current = new Map<Id, BurdenCounters>([
      ['n0', now({ nightShifts: 2 })],
      ['n1', now({ nightShifts: 3, availableDays: 8 })],
      ['n2', now({ weekendsWorked: 1 })],
    ]);
    const first = computeBurden(nurses, build(AS_OF), SCOPE, {}, current);
    const second = computeBurden(nurses, build(later), { ...SCOPE, asOf: later }, {}, current);
    for (const nurse of nurses) {
      const a = first.byNurse.get(nurse.id)!;
      const b = second.byNurse.get(nurse.id)!;
      expect(b.deviation, nurse.id).toEqual(a.deviation);
      expect(b.index, nurse.id).toEqual(a.index);
      expect(b.fairShare, nurse.id).toEqual(a.fairShare);
    }
  });

  it('a newcomer who carries exactly her share moves nobody else', () => {
    resetFixtureCounters();
    const options = { halfLifeDays: Number.POSITIVE_INFINITY };
    const team: Nurse[] = [0, 1, 2].map((i) =>
      makeNurse({ id: `n${i}`, contractedHoursPerPeriod: 72 }),
    );
    // Without decay n0's one prior fortnight doubles her exposure: fair weights 144, 72, 72 = 288.
    // Nights 4 + 2, 4 and 2 make 12, so 12 / 288 = 1/24 a weight unit and a newcomer at 72 owes 3.
    const history = [row('n0', 14, { nightShifts: 4 })];
    const current = new Map<Id, BurdenCounters>([
      ['n0', now({ nightShifts: 2 })],
      ['n1', now({ nightShifts: 4 })],
      ['n2', now({ nightShifts: 2 })],
    ]);
    const before = computeBurden(team, history, SCOPE, options, current);
    const newcomer = makeNurse({ id: 'n3', contractedHoursPerPeriod: 72 });
    const withNewcomer = new Map(current).set('n3', now({ nightShifts: 3 }));
    const after = computeBurden([...team, newcomer], history, SCOPE, options, withNewcomer);
    expect(after.byNurse.get('n3')!.deviation.nights).toBeCloseTo(0, 9);
    for (const nurse of team) {
      expect(after.byNurse.get(nurse.id)!.deviation.nights, nurse.id).toBeCloseTo(
        before.byNurse.get(nurse.id)!.deviation.nights,
        9,
      );
    }
  });

  it("keeps one holiday from swamping a nurse's standing", () => {
    resetFixtureCounters();
    const nurses = Array.from({ length: 20 }, () => makeNurse({ contractedHoursPerPeriod: 72 }));
    const current = new Map(
      nurses.map((n, i) => [n.id, now({ holidaysWorked: i === 0 ? 1 : 0 })] as const),
    );
    const report = computeBurden(
      nurses,
      [],
      SCOPE,
      { weights: onlyWeights({ holidays: 3 }) },
      current,
    );
    const holder = report.byNurse.get(nurses[0]!.id)!;
    // Fair share 1/20 = 0.05, so (1 − 0.05) / 0.05 = 19 over; on the index 3 × 19/(1 + 19) = 2.85.
    expect(holder.deviation.holidays).toBeCloseTo(19, 9);
    expect(holder.index).toBeCloseTo(2.85, 9);
    for (const nurse of nurses.slice(1)) {
      // Under share stays raw: 3 × −1.
      expect(report.byNurse.get(nurse.id)!.index).toBeCloseTo(-3, 9);
    }
  });

  it("ignores a leave period's untouched preferences", () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    const history = [row(nurse.id, 14, { preferenceHitRate: 1, availableDays: 0 })];
    const current = new Map([[nurse.id, now({ preferenceHitRate: 0.5 })]]);
    const report = computeBurden([nurse], history, SCOPE, {}, current);
    expect(report.byNurse.get(nurse.id)!.carried.preferenceHitRate).toBe(0.5);
  });

  it("carries each nurse's fair share on the report", () => {
    resetFixtureCounters();
    const a = makeNurse({ contractedHoursPerPeriod: 72 });
    const b = makeNurse({ contractedHoursPerPeriod: 72 });
    const current = new Map([
      [a.id, now({ nightShifts: 12 })],
      [b.id, now({ nightShifts: 4 })],
    ]);
    const report = computeBurden([a, b], [], SCOPE, {}, current);
    // 16 nights over two equal weights of 72: 8 each.
    expect(report.byNurse.get(a.id)!.fairShare.nights).toBeCloseTo(8, 9);
    expect(report.byNurse.get(b.id)!.fairShare.nights).toBeCloseTo(8, 9);
  });

  it('refuses counters built for a different period length', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ id: 'ana' });
    const current = new Map([[nurse.id, now({ periodDays: 7, availableDays: 7 })]]);
    expect(() =>
      computeBurden([nurse], [], SCOPE, { weights: DEFAULT_FAIRNESS_WEIGHTS }, current),
    ).toThrow('Counters for nurse ana cover 7 days but the period being scored has 14.');
  });

  it('refuses a history row with more days available than its period', () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    const bad = row(nurse.id, 14, { id: 'ledger-bad', availableDays: 15 });
    expect(() => computeBurden([nurse], [bad], SCOPE)).toThrow(
      'Fairness history row ledger-bad has an invalid period length or available days.',
    );
  });

  it('weights rows by the hand-computed half-life', () => {
    // Sanity on the helper the other tests reason with: age 180 is a half, age 7 is 0.973404.
    expect(w(180)).toBeCloseTo(0.5, 12);
    expect(w(7)).toBeCloseTo(0.973404, 6);
  });
});
