import { describe, expect, it } from 'vitest';
import type { FmlaPolicy } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  fmlaEligibility,
  fmlaEntitlementHours,
  fmlaPeriod,
  fmlaStanding,
  pdlEntitlementHours,
} from './fmla.js';

const d = isoDate;
const backward: FmlaPolicy = { regime: 'title1', yearMethod: 'rolling_backward' };
const forward: FmlaPolicy = { regime: 'title1', yearMethod: 'rolling_forward' };
const calendar: FmlaPolicy = { regime: 'title1', yearMethod: 'calendar' };

describe('how many FMLA hours a nurse gets', () => {
  it('gives a VA nurse on 80 hours every 14 days 480 hours, six biweekly tours', () => {
    expect(fmlaEntitlementHours({ regime: 'title5', contractWeeklyHours: 40 })).toEqual({
      hours: 480,
      basis: 'title5_tour',
    });
  });

  it('gives a nurse on three 12s under Title I 432 hours when there is no history', () => {
    expect(fmlaEntitlementHours({ regime: 'title1', contractWeeklyHours: 36 })).toEqual({
      hours: 432,
      basis: 'contract',
    });
  });

  it('uses the 52-week average when the schedule varied: 1,820 hours is 35 a week, 420', () => {
    expect(
      fmlaEntitlementHours({
        regime: 'title1',
        contractWeeklyHours: 36,
        scheduledHoursLast52Weeks: 1820,
      }),
    ).toEqual({ hours: 420, basis: 'average' });
  });
});

describe('FMLA eligibility', () => {
  it('needs a year on staff and 1,250 hours worked in it under Title I', () => {
    expect(
      fmlaEligibility({
        regime: 'title1',
        hiredOn: d('2026-02-01'),
        onDate: d('2027-03-01'),
        hoursLast12Months: 1300,
      }),
    ).toEqual({ eligible: true });
    expect(
      fmlaEligibility({
        regime: 'title1',
        hiredOn: d('2026-06-01'),
        onDate: d('2027-03-01'),
        hoursLast12Months: 1300,
      }),
    ).toEqual({ eligible: false, reason: 'Employed 9 months; FMLA needs 12.' });
    expect(
      fmlaEligibility({
        regime: 'title1',
        hiredOn: d('2020-01-01'),
        onDate: d('2027-03-01'),
        hoursLast12Months: 1100,
      }),
    ).toEqual({
      eligible: false,
      reason: 'Worked 1,100 hours in the last 12 months; FMLA needs 1,250.',
    });
  });

  it('refuses to judge a Title I nurse without their hours', () => {
    expect(() =>
      fmlaEligibility({ regime: 'title1', hiredOn: d('2020-01-01'), onDate: d('2027-03-01') }),
    ).toThrow();
  });

  it('ignores the 1,250-hour test for a federal nurse', () => {
    expect(
      fmlaEligibility({
        regime: 'title5',
        hiredOn: d('2020-01-01'),
        onDate: d('2027-03-01'),
        hoursLast12Months: 100,
      }),
    ).toEqual({ eligible: true });
  });

  it('still wants 12 months of federal service', () => {
    expect(
      fmlaEligibility({ regime: 'title5', hiredOn: d('2026-06-01'), onDate: d('2027-03-01') }),
    ).toEqual({
      eligible: false,
      reason: 'Employed 9 months; FMLA needs 12 months of federal service.',
    });
  });
});

describe('which twelve months FMLA is counted in', () => {
  it('counts a fixed fiscal year starting 10-01 on 2026-09-30 as the year that began 2025-10-01', () => {
    const policy: FmlaPolicy = { regime: 'title1', yearMethod: 'fixed', fixedYearStart: '10-01' };
    expect(fmlaPeriod(policy, d('2026-09-30'), [])).toEqual({
      from: d('2025-10-01'),
      to: d('2026-09-30'),
    });
    expect(fmlaPeriod(policy, d('2026-10-01'), [])).toEqual({
      from: d('2026-10-01'),
      to: d('2027-09-30'),
    });
  });

  it('refuses a fixed year with no start, a bad start, or 02-29', () => {
    for (const fixedYearStart of [undefined, '10/01', '02-29']) {
      const policy: FmlaPolicy = { regime: 'title1', yearMethod: 'fixed', fixedYearStart };
      expect(() => fmlaPeriod(policy, d('2026-09-30'), [])).toThrow();
    }
  });

  it('runs a rolling-forward year from the first leave: 2026-02-10 to 2027-02-09', () => {
    expect(fmlaPeriod(forward, d('2026-11-01'), [d('2026-02-10')])).toEqual({
      from: d('2026-02-10'),
      to: d('2027-02-09'),
    });
  });

  it('starts a new rolling-forward year on the day of leave asked after the last one ended', () => {
    expect(fmlaPeriod(forward, d('2027-03-01'), [d('2026-02-10'), d('2026-02-11')])).toEqual({
      from: d('2027-03-01'),
      to: d('2028-02-29'),
    });
  });

  it('starts the second rolling-forward year on the first leave day after the first ends', () => {
    expect(
      fmlaPeriod(forward, d('2027-04-01'), [d('2026-02-10'), d('2027-03-01'), d('2027-03-02')]),
    ).toEqual({ from: d('2027-03-01'), to: d('2028-02-29') });
  });

  it('keeps leave on the last day of a rolling-forward year in that year, 2027-02-09', () => {
    expect(fmlaPeriod(forward, d('2027-02-09'), [d('2026-02-10')])).toEqual({
      from: d('2026-02-10'),
      to: d('2027-02-09'),
    });
    // The 02-09 leave belongs to the first year, so it does not open a second one.
    expect(fmlaPeriod(forward, d('2027-03-01'), [d('2026-02-10'), d('2027-02-09')])).toEqual({
      from: d('2027-03-01'),
      to: d('2028-02-29'),
    });
  });

  it('starts a new rolling-forward year on the anniversary, 2027-02-10', () => {
    expect(fmlaPeriod(forward, d('2027-02-11'), [d('2026-02-10'), d('2027-02-10')])).toEqual({
      from: d('2027-02-10'),
      to: d('2028-02-09'),
    });
  });

  it('starts a rolling-forward year today when there is no leave before', () => {
    expect(fmlaPeriod(forward, d('2026-10-05'), [])).toEqual({
      from: d('2026-10-05'),
      to: d('2027-10-04'),
    });
  });

  it('counts a rolling-backward year as exactly twelve months, 2025-10-06 to 2026-10-05', () => {
    expect(fmlaPeriod(backward, d('2026-10-05'), [])).toEqual({
      from: d('2025-10-06'),
      to: d('2026-10-05'),
    });
  });

  it('opens the year back on 1 March when the day is 29 February', () => {
    // 2027 has no 29 Feb, so the same day a year earlier is 2027-03-01 and the year opens the day after.
    expect(fmlaPeriod(backward, d('2028-02-29'), [])).toEqual({
      from: d('2027-03-02'),
      to: d('2028-02-29'),
    });
  });

  it('counts a calendar year as 1 January to 31 December', () => {
    expect(fmlaPeriod(calendar, d('2026-12-20'), [])).toEqual({
      from: d('2026-01-01'),
      to: d('2026-12-31'),
    });
  });

  it('ignores a calendar setting for a federal nurse: Title 5 starts on the first day of leave', () => {
    const policy: FmlaPolicy = { regime: 'title5', yearMethod: 'calendar' };
    expect(fmlaPeriod(policy, d('2026-11-01'), [d('2026-02-10')])).toEqual({
      from: d('2026-02-10'),
      to: d('2027-02-09'),
    });
  });
});

describe('FMLA hours left', () => {
  it('does not count December leave against January leave in a calendar year', () => {
    const standing = fmlaStanding({
      policy: calendar,
      entitlementHours: 432,
      usedHours: [{ date: d('2026-12-20'), hours: 100 }],
      onDate: d('2027-01-05'),
    });
    expect(standing).toEqual({
      period: { from: d('2027-01-01'), to: d('2027-12-31') },
      usedHours: 0,
      remainingHours: 432,
    });
  });

  it('counts leave approved later in the same year too', () => {
    const standing = fmlaStanding({
      policy: calendar,
      entitlementHours: 432,
      usedHours: [
        { date: d('2027-01-02'), hours: 36 },
        { date: d('2027-06-01'), hours: 72 },
      ],
      onDate: d('2027-01-05'),
    });
    expect(standing.usedHours).toBe(108);
    expect(standing.remainingHours).toBe(324);
  });

  it('counts only leave in the year back from the date, a rolling year', () => {
    const standing = fmlaStanding({
      policy: backward,
      entitlementHours: 432,
      usedHours: [
        { date: d('2026-03-01'), hours: 36 }, // the day a year before 2027-03-01: outside
        { date: d('2026-03-02'), hours: 72 }, // first day inside
        { date: d('2027-02-01'), hours: 12 },
      ],
      onDate: d('2027-03-01'),
    });
    expect(standing.remainingHours).toBe(432 - 84);
  });

  it('keeps a VA nurse’s two Title 5 years apart: a year opens on the first day of leave', () => {
    const usedHours = [
      { date: d('2026-02-10'), hours: 40 },
      { date: d('2027-03-01'), hours: 24 },
    ];
    const policy: FmlaPolicy = { regime: 'title5', yearMethod: 'rolling_backward' };
    expect(
      fmlaStanding({ policy, entitlementHours: 480, usedHours, onDate: d('2027-03-01') }),
    ).toEqual({
      period: { from: d('2027-03-01'), to: d('2028-02-29') },
      usedHours: 24,
      remainingHours: 456,
    });
    // Asked in June 2026 the year is the one the February leave opened; March 2027 is outside it.
    expect(
      fmlaStanding({ policy, entitlementHours: 480, usedHours, onDate: d('2026-06-01') }),
    ).toEqual({
      period: { from: d('2026-02-10'), to: d('2027-02-09') },
      usedHours: 40,
      remainingHours: 440,
    });
  });

  it('never goes below zero', () => {
    expect(
      fmlaStanding({
        policy: backward,
        entitlementHours: 432,
        usedHours: [{ date: d('2027-01-05'), hours: 500 }],
        onDate: d('2027-03-01'),
      }).remainingHours,
    ).toBe(0);
  });
});

describe('California pregnancy disability leave', () => {
  it('gives a nurse on three 12s 623.88 hours, four months of her 36-hour week', () => {
    // 36 × 17.33 = 623.88.
    expect(pdlEntitlementHours({ contractWeeklyHours: 36 })).toBeCloseTo(623.88, 10);
  });

  it('gives a 40-hour nurse 693.2 hours', () => {
    // 40 × 17.33 = 693.2.
    expect(pdlEntitlementHours({ contractWeeklyHours: 40 })).toBeCloseTo(693.2, 10);
  });
});
