import { describe, expect, it } from 'vitest';
import type { FairnessLedgerEntry } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { burdenFairShare, computeBurden } from './burden.js';
import { EMPTY_COUNTERS } from './types.js';

let ledgerCounter = 0;

/** One ledger row, most fields defaulted to zero so a test only states what it cares about. */
function ledgerRow(
  nurseId: string,
  periodStart: string,
  overrides: Partial<FairnessLedgerEntry> = {},
): FairnessLedgerEntry {
  ledgerCounter++;
  return {
    id: `ledger-${ledgerCounter}`,
    nurseId,
    periodId: overrides.periodId ?? `period-${ledgerCounter}`,
    periodStart: isoDate(periodStart),
    ...EMPTY_COUNTERS,
    ...overrides,
  };
}

describe('carried burden and deviation from fair share', () => {
  it('a nurse who carried 12 nights against a peer with 4 is 50% over share; the peer is 50% under', () => {
    resetFixtureCounters();
    const a = makeNurse({ contractedHoursPerPeriod: 72 });
    const b = makeNurse({ contractedHoursPerPeriod: 72 });
    const current = new Map([
      [a.id, { ...EMPTY_COUNTERS, nightShifts: 12 }],
      [b.id, { ...EMPTY_COUNTERS, nightShifts: 4 }],
    ]);
    const report = computeBurden([a, b], [], {}, current);
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
      [fullTime.id, { ...EMPTY_COUNTERS, nightShifts: 8 }],
      [halfTime.id, { ...EMPTY_COUNTERS, nightShifts: 4 }],
    ]);
    const report = computeBurden([fullTime, halfTime], [], {}, current);
    expect(report.byNurse.get(fullTime.id)!.deviation.nights).toBeCloseTo(0, 9);
    expect(report.byNurse.get(halfTime.id)!.deviation.nights).toBeCloseTo(0, 9);
  });

  it('decays older history: 8 nights last period plus 8 the period before, at 0.85 decay, carries as 8 + 6.8', () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    const history = [
      ledgerRow(nurse.id, '2026-08-01', { nightShifts: 8 }),
      ledgerRow(nurse.id, '2026-07-01', { nightShifts: 8 }),
    ];
    const report = computeBurden([nurse], history, { decay: 0.85 });
    // No current period: k=0 (most recent) weighs decay^0 = 1, k=1 weighs decay^1 = 0.85.
    expect(report.byNurse.get(nurse.id)!.carried.nightShifts).toBeCloseTo(8 + 8 * 0.85, 9);
  });

  it('with decay 0.5 and two history rows (8 then 8), no current period carries as 8 + 4 = 12', () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    const history = [
      ledgerRow(nurse.id, '2026-08-01', { nightShifts: 8 }),
      ledgerRow(nurse.id, '2026-07-01', { nightShifts: 8 }),
    ];
    const report = computeBurden([nurse], history, { decay: 0.5 });
    expect(report.byNurse.get(nurse.id)!.carried.nightShifts).toBeCloseTo(12, 9);
  });

  it('a window of 2 periods ignores a third, older ledger row entirely', () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    const history = [
      ledgerRow(nurse.id, '2026-08-01', { nightShifts: 4 }),
      ledgerRow(nurse.id, '2026-07-01', { nightShifts: 4 }),
      ledgerRow(nurse.id, '2026-01-01', { nightShifts: 100 }), // outside the window
    ];
    const report = computeBurden([nurse], history, { windowPeriods: 2, decay: 1 });
    expect(report.byNurse.get(nurse.id)!.carried.nightShifts).toBeCloseTo(8, 9);
    expect(report.byNurse.get(nurse.id)!.periodsInWindow).toBe(2);
  });

  it('a per-diem nurse with no contracted hours and no history cannot be compared to the team', () => {
    resetFixtureCounters();
    const perDiem = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const staffed = makeNurse({ contractedHoursPerPeriod: 72 });
    const current = new Map([[staffed.id, { ...EMPTY_COUNTERS, nightShifts: 4 }]]);
    const report = computeBurden([perDiem, staffed], [], {}, current);
    const nb = report.byNurse.get(perDiem.id)!;
    expect(nb.shareWeight).toBe(0);
    expect(nb.index).toBe(0);
    for (const value of Object.values(nb.deviation)) {
      expect(value).toBe(0);
    }
  });

  it('a per-diem nurse with a history of worked hours gets a fair share based on their own average', () => {
    resetFixtureCounters();
    const perDiem = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const history = [
      ledgerRow(perDiem.id, '2026-08-01', { totalHours: 20 }),
      ledgerRow(perDiem.id, '2026-07-01', { totalHours: 40 }),
    ];
    const report = computeBurden([perDiem], history, { decay: 1 });
    // shareWeight falls back to the unweighted mean of historical totalHours: (20+40)/2 = 30.
    expect(report.byNurse.get(perDiem.id)!.shareWeight).toBeCloseTo(30, 9);
  });

  it('a denied time-off request pulls a nurse behind the team and pushes their deviation positive', () => {
    resetFixtureCounters();
    const denied = makeNurse();
    const approved = makeNurse();
    const current = new Map([
      [denied.id, { ...EMPTY_COUNTERS, requestsApproved: 1, requestsDenied: 1 }], // 50%
      [approved.id, { ...EMPTY_COUNTERS, requestsApproved: 2, requestsDenied: 0 }], // 100%
    ]);
    const report = computeBurden([denied, approved], [], {}, current);
    // Team rate = (1+2)/(2+2) = 0.75. denied's own rate = 0.5, so 0.75 - 0.5 = +0.25.
    expect(report.byNurse.get(denied.id)!.deviation.timeOff).toBeCloseTo(0.25, 9);
    expect(report.byNurse.get(approved.id)!.deviation.timeOff).toBeCloseTo(-0.25, 9);
  });

  it('preference hit rate is carried as a weighted mean, not summed across periods', () => {
    resetFixtureCounters();
    const nurse = makeNurse();
    const history = [
      ledgerRow(nurse.id, '2026-08-01', { preferenceHitRate: 1.0 }),
      ledgerRow(nurse.id, '2026-07-01', { preferenceHitRate: 0.5 }),
    ];
    const report = computeBurden([nurse], history, { decay: 0.5 });
    // Weighted mean: (1.0*1 + 0.5*0.5) / (1 + 0.5) = 1.25 / 1.5 = 0.8333...
    // (If this were a sum it would be 1.25, which is not even a valid rate.)
    expect(report.byNurse.get(nurse.id)!.carried.preferenceHitRate).toBeCloseTo(1.25 / 1.5, 9);
  });
});

describe('burdenFairShare', () => {
  it('reproduces the same fair share the deviation was computed against', () => {
    resetFixtureCounters();
    const a = makeNurse({ contractedHoursPerPeriod: 72 });
    const b = makeNurse({ contractedHoursPerPeriod: 72 });
    const current = new Map([
      [a.id, { ...EMPTY_COUNTERS, nightShifts: 12 }],
      [b.id, { ...EMPTY_COUNTERS, nightShifts: 4 }],
    ]);
    const report = computeBurden([a, b], [], {}, current);
    expect(burdenFairShare(report.byNurse, a.id, 'nights')).toBeCloseTo(8, 9);
    expect(burdenFairShare(report.byNurse, b.id, 'nights')).toBeCloseTo(8, 9);
  });
});
