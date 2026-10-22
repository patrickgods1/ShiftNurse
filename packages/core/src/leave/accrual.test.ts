import { describe, expect, it } from 'vitest';
import type { AccrualRule } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  accrualRuleFor,
  leaveCapsFor,
  leaveYearStarts,
  projectBalance,
  yearsOfService,
} from './accrual.js';

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
    expect(p).toEqual({
      hours: 124,
      accruedHours: 24,
      usedHours: 0,
      forfeitedHours: 0,
      earnedHours: 0,
      usedThisYearHours: 0,
    });
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

  const LVN_ANNUAL: AccrualRule = {
    balanceType: 'annual',
    roles: ['LPN'],
    tiers: [
      { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
      { fromYearsOfService: 3, hoursPerPayPeriod: 6 },
      { fromYearsOfService: 15, hoursPerPayPeriod: 8 },
    ],
  };

  it('keeps an LVN at 4 hours in the pay period her 3-year anniversary falls in, and pays 6 from the next', () => {
    // Anniversary 2026-11-10. Periods closing before 12-01: 10-31 (10-18..10-31; the day before,
    // 10-17, is 2 years in: 4), 11-14 (11-01..11-14, holding the anniversary; the day before,
    // 10-31, is 2 years: 4), 11-28 (11-15..11-28; the day before, 11-14, is past 11-10: 3 years,
    // 6). 4 + 4 + 6 = 14; 50 + 14 = 64.
    const p = projectBalance({
      ...base,
      balanceHours: 50,
      asOf: d('2026-10-17'),
      onDate: d('2026-12-01'),
      serviceStart: d('2023-11-10'),
      rule: LVN_ANNUAL,
    });
    expect(p.accruedHours).toBe(14);
    expect(p.hours).toBe(64);
  });

  it('starts the higher rate in the period after the one that opens on the anniversary', () => {
    // Anniversary 2026-11-15, the first day of period 11-15..11-28: the service is completed in
    // that period, so it still earns 4. Periods: 10-31 (day before 10-17: 2 years, 4), 11-14 (day
    // before 10-31: 2, 4), 11-28 (day before 11-14: 2, 4), 12-12 (11-29..12-12; day before
    // 11-28: 3, 6). 4 + 4 + 4 + 6 = 18; 50 + 18 = 68.
    const p = projectBalance({
      ...base,
      balanceHours: 50,
      asOf: d('2026-10-17'),
      onDate: d('2026-12-15'),
      serviceStart: d('2023-11-15'),
      rule: LVN_ANNUAL,
    });
    expect(p.accruedHours).toBe(18);
    expect(p.hours).toBe(68);
  });

  const FEDERAL_ANNUAL: AccrualRule = {
    balanceType: 'annual',
    tiers: [
      { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
      { fromYearsOfService: 3, hoursPerPayPeriod: 6, lastPayPeriodOfYearHours: 10 },
      { fromYearsOfService: 15, hoursPerPayPeriod: 8 },
    ],
  };

  it("pays a federal nurse with 3 to 15 years 10 hours in the leave year's last pay period", () => {
    // Leave year 2027 starts on the first period beginning on or after 1 January: periods start
    // 12-27 and 01-10, so 2027-01-10. Period 12-13..12-26: no leave year starts in
    // (12-26, 01-09], so 6. Period 12-27..01-09: 01-10 is in (01-09, 01-23], so 10. 6 + 10 = 16.
    const p = projectBalance({
      ...base,
      leaveYearStart: 'first_full_pay_period',
      balanceHours: 0,
      asOf: d('2026-12-20'),
      onDate: d('2027-01-20'),
      serviceStart: d('2020-01-01'),
      rule: FEDERAL_ANNUAL,
    });
    expect(p.accruedHours).toBe(16);
  });

  it('earns a federal nurse with 6 years exactly 20 days in a 26-period leave year', () => {
    // Leave year 2027-01-10..2028-01-08: 2027-01-10 + 26 × 14 days = 2028-01-09, the next
    // leave-year start, so 26 periods close inside. 25 × 6 + 10 = 160 = 20 days of 8 hours, the
    // year § 6303(a)(2) promises (three-fourths day, 1¼ days in the last period).
    const p = projectBalance({
      ...base,
      leaveYearStart: 'first_full_pay_period',
      balanceHours: 0,
      asOf: d('2027-01-09'),
      onDate: d('2028-01-10'),
      serviceStart: d('2020-01-01'),
      rule: FEDERAL_ANNUAL,
    });
    expect(p.accruedHours).toBe(160);
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
    expect(p).toEqual({
      hours: 240,
      accruedHours: 0,
      usedHours: 0,
      forfeitedHours: 10,
      earnedHours: 0,
      usedThisYearHours: 0,
    });
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
    expect(p).toEqual({
      hours: 240,
      accruedHours: 8,
      usedHours: 0,
      forfeitedHours: 18,
      earnedHours: 0,
      usedThisYearHours: 0,
    });
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
    expect(p).toEqual({
      hours: 80,
      accruedHours: 1,
      usedHours: 0,
      forfeitedHours: 0,
      earnedHours: 0,
      usedThisYearHours: 0,
    });
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
    // figure and the 11-20 entry is the request being checked. Used this year counts the 10-17
    // entry too: 8 + 36 = 44.
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
    expect(p).toEqual({
      hours: 80,
      accruedHours: 16,
      usedHours: 36,
      forfeitedHours: 0,
      earnedHours: 0,
      usedThisYearHours: 44,
    });
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
    expect(p).toEqual({
      hours: 34,
      accruedHours: 0,
      usedHours: 16,
      forfeitedHours: 0,
      earnedHours: 0,
      usedThisYearHours: 16,
    });
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
    expect(p).toEqual({
      hours: 20,
      accruedHours: 10,
      usedHours: 0,
      forfeitedHours: 0,
      earnedHours: 0,
      usedThisYearHours: 0,
    });
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
      expect(p).toEqual({
        hours: 248,
        accruedHours: 8,
        usedHours: 0,
        forfeitedHours: 10,
        earnedHours: 0,
        usedThisYearHours: 0,
      });
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
      expect(p).toEqual({
        hours: 0,
        accruedHours: 4,
        usedHours: 10,
        forfeitedHours: 0,
        earnedHours: 0,
        usedThisYearHours: 10,
      });
    });
  });
});

describe('how much of the balance a nurse has used this leave year', () => {
  it('counts leave taken before payroll’s date in the same year, and nothing from last year', () => {
    // Calendar leave year from 2026-01-01. 2025-12-29 is last year's; 03-10 (16) and 10-17 (8)
    // are already in payroll's figure but were used this year; 10-20 (8) is after it; 11-20 is
    // the request being checked. 16 + 8 + 8 = 32. The balance only moves by 10-20's 8: 50 - 8.
    const p = projectBalance({
      ...base,
      balanceHours: 50,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-20'),
      used: [
        { date: d('2025-12-29'), hours: 12 },
        { date: d('2026-03-10'), hours: 16 },
        { date: d('2026-10-17'), hours: 8 },
        { date: d('2026-10-20'), hours: 8 },
        { date: d('2026-11-20'), hours: 16 },
      ],
    });
    expect(p.usedThisYearHours).toBe(32);
    expect(p.hours).toBe(42);
  });

  it('starts the count again at the federal leave year, 2027-01-10, not on 1 January', () => {
    // Federal year starts 2027-01-10 (see above). 01-05 is still 2026's year; 01-12 is 2027's.
    const p = projectBalance({
      ...base,
      leaveYearStart: 'first_full_pay_period',
      balanceHours: 50,
      asOf: d('2026-12-20'),
      onDate: d('2027-01-20'),
      used: [
        { date: d('2027-01-05'), hours: 12 },
        { date: d('2027-01-12'), hours: 8 },
      ],
    });
    expect(p.usedThisYearHours).toBe(8);
  });
});

describe('a front-loaded balance', () => {
  // Calendar leave year; periods close 12-26 and 2027-01-09 between the dates below.
  const FRONT_LOADED: AccrualRule = {
    balanceType: 'sick',
    tiers: [],
    frontLoadHours: 40,
  };

  it('gives a nurse 40 hours on 1 January whatever she carried, and accrues nothing per period', () => {
    // 12 held on 12-20. 12-26 closes a period but a front-loaded rule earns nothing per period;
    // 01-01 sets the balance to 40, and the 12 carried in are not kept; 01-09 earns nothing.
    const p = projectBalance({
      ...base,
      balanceHours: 12,
      asOf: d('2026-12-20'),
      onDate: d('2027-01-20'),
      rule: FRONT_LOADED,
    });
    expect(p.hours).toBe(40);
    expect(p.accruedHours).toBe(40);
    expect(p.forfeitedHours).toBe(12);
  });

  it('gives the full 40 even where the carryover cap is lower', () => {
    // § 246(d): a front-loaded balance need not carry over at all, so the cap of 30 on what is
    // carried does not trim the new year's 40.
    const p = projectBalance({
      ...base,
      balanceHours: 12,
      asOf: d('2026-12-20'),
      onDate: d('2027-01-20'),
      rule: { ...FRONT_LOADED, carryoverCapHours: 30 },
      used: [{ date: d('2027-01-05'), hours: 12 }],
    });
    expect(p.hours).toBe(28);
    expect(p.usedThisYearHours).toBe(12);
  });

  it('accrues nothing between payroll’s figure and the request inside one leave year', () => {
    const p = projectBalance({
      ...base,
      balanceHours: 24,
      asOf: d('2026-10-17'),
      onDate: d('2026-12-01'),
      rule: FRONT_LOADED,
    });
    expect(p).toEqual({
      hours: 24,
      accruedHours: 0,
      usedHours: 0,
      forfeitedHours: 0,
      earnedHours: 0,
      usedThisYearHours: 0,
    });
  });
});

describe('caps in hours or days, whichever is greater', () => {
  it('lets a 12-hour nurse use 60 hours of sick leave a year, not 40', () => {
    // 5 days x 12 h = 60, more than 40.
    expect(leaveCapsFor({ useCapHoursPerYear: 40, useCapDaysPerYear: 5 }, 12)).toEqual({
      useCapHoursPerYear: 60,
    });
  });

  it('keeps an 8-hour nurse at 40 hours', () => {
    // 5 days x 8 h = 40, the same as the hours.
    expect(leaveCapsFor({ useCapHoursPerYear: 40, useCapDaysPerYear: 5 }, 8)).toEqual({
      useCapHoursPerYear: 40,
    });
  });

  it('lets a 12-hour nurse bank 120 hours', () => {
    // 10 days x 12 h = 120, more than 80.
    expect(leaveCapsFor({ balanceCapHours: 80, balanceCapDays: 10 }, 12)).toEqual({
      balanceCapHours: 120,
    });
  });

  it('needs the shift length to apply a cap in days', () => {
    expect(() => leaveCapsFor({ balanceCapDays: 10 }, undefined)).toThrow(/usual shift length/);
  });

  it('refuses to project a balance capped in days without the unit’s usual shift', () => {
    expect(() =>
      projectBalance({
        ...base,
        balanceHours: 50,
        asOf: d('2026-10-17'),
        onDate: d('2026-11-05'),
        rule: {
          balanceType: 'sick',
          tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 10 }],
          balanceCapHours: 80,
          balanceCapDays: 10,
        },
      }),
    ).toThrow(/usual shift length/);
  });

  it('stops a 12-hour nurse’s accrual at 120 hours, not 80', () => {
    // One period closes inside (10-18..10-31): 115 + 10 = 125, capped at 120, so 5 earned.
    const rule: AccrualRule = {
      balanceType: 'sick',
      tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 10 }],
      balanceCapHours: 80,
      balanceCapDays: 10,
    };
    const input = {
      ...base,
      balanceHours: 115,
      asOf: d('2026-10-17'),
      onDate: d('2026-11-05'),
      shiftHours: 12,
    };
    const p = projectBalance({ ...input, rule });
    expect(p.hours).toBe(120);
    expect(p.accruedHours).toBe(5);
    // The same nurse under an hours-only cap of 80 is already over it and earns nothing.
    const { balanceCapDays: _, ...hoursOnly } = rule;
    const old = projectBalance({ ...input, rule: hoursOnly });
    expect(old.hours).toBe(115);
    expect(old.accruedHours).toBe(0);
  });
});

describe('comp time earned since payroll gave the figure', () => {
  const comp = { ...base, balanceHours: 10, asOf: d('2026-10-17'), onDate: d('2026-10-30') };

  it('raises the projection by the comp time credited on a day in between', () => {
    // 10 held + 6 credited on 10-20 = 16.
    const p = projectBalance({ ...comp, earned: [{ date: d('2026-10-20'), hours: 6 }] });
    expect(p.hours).toBe(16);
    expect(p.earnedHours).toBe(6);
  });

  it('does not count comp time credited on the request day itself yet', () => {
    // Same window as use: after payroll's date, before the request's.
    const p = projectBalance({ ...comp, earned: [{ date: d('2026-10-30'), hours: 6 }] });
    expect(p.hours).toBe(10);
    expect(p.earnedHours).toBe(0);
  });

  it('reports no earned hours when none was credited', () => {
    expect(projectBalance(comp).earnedHours).toBe(0);
  });

  it('lets comp time credited on a day cover leave used the same day', () => {
    // 10 + 6 earned - 14 used = 2. Earn applies first, so the balance is never negative midway.
    const p = projectBalance({
      ...comp,
      earned: [{ date: d('2026-10-20'), hours: 6 }],
      used: [{ date: d('2026-10-20'), hours: 14 }],
    });
    expect(p.hours).toBe(2);
    expect(p.usedHours).toBe(14);
  });

  it('does not stop comp time at the accrual rule’s balance cap', () => {
    // Capped at 80 and holding 78, a 12-hour credit still lands whole: comp time has its own
    // cap, applied when it is credited. 78 + 12 = 90.
    const p = projectBalance({
      ...comp,
      balanceHours: 78,
      rule: {
        balanceType: 'comp',
        tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
        balanceCapHours: 80,
      },
      earned: [{ date: d('2026-10-20'), hours: 12 }],
    });
    // The 10-31 period closes after the request day, so no accrual enters.
    expect(p.hours).toBe(90);
  });
});
