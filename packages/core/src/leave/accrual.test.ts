import { describe, expect, it } from 'vitest';
import type { AccrualRule } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { accrualRuleFor, leaveYearStarts, projectBalance, yearsOfService } from './accrual.js';

const d = isoDate;

// Sunday-anchored 14-day periods. Starts: 2026-10-04, 10-18, 11-01, 11-15, 11-29, 12-13, 12-27,
// 2027-01-10. Each ends the day before the next starts (10-17, 10-31, 11-14, 11-28, ...).
const CALENDAR = { payPeriodAnchor: d('2026-10-04'), payPeriodDays: 14 };

const VA_RN_ANNUAL: AccrualRule = {
  balanceType: 'annual',
  roles: ['RN'],
  employmentTypes: ['full_time'],
  tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
  carryoverCapHours: 685,
};

const base = {
  calendar: CALENDAR,
  leaveYearStart: 'calendar' as const,
  serviceStart: d('2015-06-01'),
  used: [],
};

describe('years of service', () => {
  it('counts the anniversary on the day itself', () => {
    expect(yearsOfService(d('2023-11-10'), d('2026-11-09'))).toBe(2);
    expect(yearsOfService(d('2023-11-10'), d('2026-11-10'))).toBe(3);
  });

  it('is zero before a nurse has been there a year', () => {
    expect(yearsOfService(d('2026-03-01'), d('2026-10-05'))).toBe(0);
  });
});

describe('finding the accrual rule that covers a nurse', () => {
  const policy = {
    fmla: { regime: 'title1' as const, yearMethod: 'calendar' as const },
    leaveYearStart: 'calendar' as const,
    accrual: [
      VA_RN_ANNUAL,
      { balanceType: 'sick' as const, tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 4 }] },
    ],
  };

  it('picks the full-time RN annual rule for a full-time RN', () => {
    expect(accrualRuleFor(policy, { role: 'RN', employmentType: 'full_time' }, 'annual')).toBe(
      VA_RN_ANNUAL,
    );
  });

  it('gives a part-time RN no annual rule when only full-time is covered', () => {
    expect(
      accrualRuleFor(policy, { role: 'RN', employmentType: 'part_time' }, 'annual'),
    ).toBeUndefined();
  });

  it('lets a rule without role or type lists cover everyone for sick leave', () => {
    expect(
      accrualRuleFor(policy, { role: 'CNA', employmentType: 'per_diem' }, 'sick'),
    ).toBeDefined();
  });
});

describe('when a leave year turns over', () => {
  it('is every 1 January on a calendar leave year', () => {
    expect(leaveYearStarts('calendar', CALENDAR, d('2026-06-01'), d('2028-01-01'))).toEqual([
      d('2027-01-01'),
      d('2028-01-01'),
    ]);
  });

  it('does not count a start on the day the balance was last given', () => {
    expect(leaveYearStarts('calendar', CALENDAR, d('2027-01-01'), d('2027-12-31'))).toEqual([]);
  });

  it('starts the federal year on 2027-01-10 when periods begin 2026-12-27 and 2027-01-10', () => {
    // 2026-12-27 begins before 1 January 2027, so the first period beginning on or after it is
    // 2026-12-27 + 14 days = 2027-01-10.
    expect(
      leaveYearStarts('first_full_pay_period', CALENDAR, d('2026-12-01'), d('2027-02-01')),
    ).toEqual([d('2027-01-10')]);
  });

  it('starts the federal year of 2026 on 2026-01-11', () => {
    // 2025-12-28 starts before 1 January 2026; +14 days = 2026-01-11.
    expect(
      leaveYearStarts('first_full_pay_period', CALENDAR, d('2025-12-31'), d('2026-03-01')),
    ).toEqual([d('2026-01-11')]);
  });
});

describe('projecting a balance forward from payroll', () => {
  it('adds 24 hours for a full-time VA RN when three pay periods close before the request', () => {
    // Periods ending 10-31, 11-14, 11-28 close after asOf 10-17 and before 12-01: 3 x 8 = 24.
    // 10-17 itself is already in payroll's figure; 12-12 is after the request.
    const p = projectBalance({
      ...base,
      balanceHours: 100,
      asOf: d('2026-10-17'),
      onDate: d('2026-12-01'),
      rule: VA_RN_ANNUAL,
    });
    expect(p).toEqual({ hours: 124, accruedHours: 24, usedHours: 0, forfeitedHours: 0 });
  });

  it('earns a part-time RN one hour per ten in pay status', () => {
    // Periods starting 10-18 (64h) and 11-01 (72h) close 10-31 and 11-14: 64/10 + 72/10 = 13.6.
    const p = projectBalance({
      ...base,
      balanceHours: 20,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      rule: {
        balanceType: 'annual',
        tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 10 }],
      },
      hoursByPayPeriodStart: new Map([
        [d('2026-10-18'), 64],
        [d('2026-11-01'), 72],
      ]),
    });
    expect(p.accruedHours).toBeCloseTo(13.6, 10);
    expect(p.hours).toBeCloseTo(33.6, 10);
  });

  it('counts a pay period with no hours reported as nothing earned', () => {
    const p = projectBalance({
      ...base,
      balanceHours: 20,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      rule: {
        balanceType: 'annual',
        tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 10 }],
      },
      hoursByPayPeriodStart: new Map([[d('2026-11-01'), 72]]),
    });
    expect(p.accruedHours).toBeCloseTo(7.2, 10);
  });

  it('moves an LVN from 4 to 6 hours a period when she passes her 3-year anniversary', () => {
    // Anniversary 2026-11-10. Period ending 10-31: 2 years, 4h. Ending 11-14: 3 years, 6h.
    // 4 + 6 = 10.
    const p = projectBalance({
      ...base,
      balanceHours: 50,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      serviceStart: d('2023-11-10'),
      rule: {
        balanceType: 'annual',
        roles: ['LPN'],
        tiers: [
          { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
          { fromYearsOfService: 3, hoursPerPayPeriod: 6 },
          { fromYearsOfService: 15, hoursPerPayPeriod: 8 },
        ],
      },
    });
    expect(p.accruedHours).toBe(10);
    expect(p.hours).toBe(60);
  });

  it('forfeits the 10 hours a federal nurse holds above 240 at the leave-year turnover', () => {
    // 250 held on 12-27; nothing accrues before 1 January (the period ends 01-09, after the
    // request); 1 January forfeits 250 - 240 = 10.
    const p = projectBalance({
      ...base,
      balanceHours: 250,
      asOf: d('2026-12-27'),
      onDate: d('2027-01-05'),
      rule: { ...VA_RN_ANNUAL, carryoverCapHours: 240 },
    });
    expect(p).toEqual({ hours: 240, accruedHours: 0, usedHours: 0, forfeitedHours: 10 });
  });

  it('forfeits on the federal leave-year start, not on 1 January, with Sunday-anchored periods', () => {
    // 250 on 12-27. 01-01 is not a start; 01-09 accrues 8 -> 258; 01-10 forfeits 258 - 240 = 18.
    const p = projectBalance({
      ...base,
      leaveYearStart: 'first_full_pay_period',
      balanceHours: 250,
      asOf: d('2026-12-27'),
      onDate: d('2027-01-12'),
      rule: { ...VA_RN_ANNUAL, carryoverCapHours: 240 },
    });
    expect(p).toEqual({ hours: 240, accruedHours: 8, usedHours: 0, forfeitedHours: 18 });
  });

  it('stops California sick leave at 80 hours', () => {
    // 79 held. Period ending 10-31: 120/30 = 4, but only 1 fits under 80. Ending 11-14: 0.
    const p = projectBalance({
      ...base,
      balanceHours: 79,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      rule: {
        balanceType: 'sick',
        tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 30 }],
        balanceCapHours: 80,
      },
      hoursByPayPeriodStart: new Map([
        [d('2026-10-18'), 120],
        [d('2026-11-01'), 120],
      ]),
    });
    expect(p).toEqual({ hours: 80, accruedHours: 1, usedHours: 0, forfeitedHours: 0 });
  });

  it('takes nothing away from a balance already over the cap', () => {
    const p = projectBalance({
      ...base,
      balanceHours: 85,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      rule: {
        balanceType: 'sick',
        tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 4 }],
        balanceCapHours: 80,
      },
    });
    expect(p.hours).toBe(85);
    expect(p.accruedHours).toBe(0);
  });

  it('deducts approved annual leave taken since payroll gave the figure', () => {
    // 100 + 2 x 8 (10-31, 11-14) - 36 taken on 10-20 = 80. The 10-17 entry is already in the
    // figure and the 11-20 entry is the request being checked.
    const p = projectBalance({
      ...base,
      balanceHours: 100,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      rule: VA_RN_ANNUAL,
      used: [
        { date: d('2026-10-17'), hours: 8 },
        { date: d('2026-10-20'), hours: 36 },
        { date: d('2026-11-20'), hours: 12 },
      ],
    });
    expect(p).toEqual({ hours: 80, accruedHours: 16, usedHours: 36, forfeitedHours: 0 });
  });

  it('lets the balance go negative so the manager sees the shortfall', () => {
    const p = projectBalance({
      ...base,
      balanceHours: 10,
      asOf: d('2026-10-17'),
      onDate: d('2026-10-30'),
      used: [{ date: d('2026-10-20'), hours: 24 }],
    });
    expect(p.hours).toBe(-14);
  });

  it('keeps the payroll figure minus leave used for a nurse no rule covers', () => {
    const p = projectBalance({
      ...base,
      balanceHours: 50,
      asOf: d('2026-10-17'),
      onDate: d('2026-12-01'),
      used: [{ date: d('2026-11-02'), hours: 16 }],
    });
    expect(p).toEqual({ hours: 34, accruedHours: 0, usedHours: 16, forfeitedHours: 0 });
  });

  it('is the payroll figure when the request is on the day it was given', () => {
    const p = projectBalance({
      ...base,
      balanceHours: 50,
      asOf: d('2026-10-17'),
      onDate: d('2026-10-17'),
      rule: VA_RN_ANNUAL,
    });
    expect(p.hours).toBe(50);
  });

  it('stops a period’s accrual where it only partly fits under the cap', () => {
    // 10 held, cap 20. 10-31: +8 -> 18. 11-14: only 20 - 18 = 2 of the 8 fits. Accrued 10.
    const p = projectBalance({
      ...base,
      balanceHours: 10,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      rule: {
        balanceType: 'annual',
        tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
        balanceCapHours: 20,
      },
    });
    expect(p).toEqual({ hours: 20, accruedHours: 10, usedHours: 0, forfeitedHours: 0 });
  });

  describe('on a date where several things happen', () => {
    // Periods here: 12-05..12-18, 12-19..2027-01-01, 2027-01-02..01-15. A period closes on 1 January.
    const NEW_YEAR = { payPeriodAnchor: d('2026-12-19'), payPeriodDays: 14 };

    it('forfeits down to the carryover cap before the period closing on 1 January accrues', () => {
      // 250 held, cap 240. 01-01: forfeit 10 -> 240, then accrue 8 -> 248. Accruing first would
      // give 258 and forfeit 18, leaving 240.
      const p = projectBalance({
        ...base,
        calendar: NEW_YEAR,
        balanceHours: 250,
        asOf: d('2026-12-18'),
        onDate: d('2027-01-05'),
        rule: { ...VA_RN_ANNUAL, carryoverCapHours: 240 },
      });
      expect(p).toEqual({ hours: 248, accruedHours: 8, usedHours: 0, forfeitedHours: 10 });
    });

    it('accrues before drawing leave taken on the day a period closes', () => {
      // 6 held, cap 10. 10-31: accrue min(8, 4) = 4 -> 10, then use 10 -> 0. Using first would
      // give -4, then accrue 8 capped at 10 -> 4 (a different answer).
      const p = projectBalance({
        ...base,
        balanceHours: 6,
        asOf: d('2026-10-17'),
        onDate: d('2026-11-01'),
        rule: {
          balanceType: 'annual',
          tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
          balanceCapHours: 10,
        },
        used: [{ date: d('2026-10-31'), hours: 10 }],
      });
      expect(p).toEqual({ hours: 0, accruedHours: 4, usedHours: 10, forfeitedHours: 0 });
    });
  });
});
