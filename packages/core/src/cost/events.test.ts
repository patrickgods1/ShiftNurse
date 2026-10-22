/**
 * Day-of pay worked by hand at the $48 RN rate the other cost tests use.
 */

import { describe, expect, it } from 'vitest';
import type { Differential, PayRate, ShiftType } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import {
  assign,
  DAY_8,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  scenario,
  testShiftTypes,
  testUnit,
  UNIT_ID,
} from '../testing/fixtures.js';
import { costSchedule } from './cost.js';
import { type DayOfPayEvent, priceDayOfEvents, reportingPayOwed } from './events.js';
import type { CostContext } from './types.js';

const RN_RATE: PayRate = {
  id: 'r',
  nurseId: null,
  role: 'RN',
  hourlyRate: 48,
  effectiveFrom: isoDate('2025-01-01'),
};
const ana = makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz' });
const DATE = isoDate('2027-07-06');

function ctx(differentials: Differential[] = []): CostContext {
  return {
    unit: testUnit,
    payRates: [RN_RATE],
    differentials,
    overtimeRules: [],
    holidayDates: new Set(),
    weekendDefinition: DEFAULT_WEEKEND,
    workWeekStartsOn: 0,
  };
}

function price(events: DayOfPayEvent[], c = ctx(), callBackMinimumHours = 0) {
  return priceDayOfEvents(events, c, [ana], { callBackMinimumHours });
}

describe('pay for what happened on the day', () => {
  it('pays an hour for a missed meal and another for a missed rest break, once a day each', () => {
    const result = price([
      { kind: 'missed_break', nurseId: 'ana', date: DATE, break: 'meal' },
      { kind: 'missed_break', nurseId: 'ana', date: DATE, break: 'meal' },
      { kind: 'missed_break', nurseId: 'ana', date: DATE, break: 'rest' },
    ]);
    // Labor Code § 226.7: one hour per workday for meals, one for rest: $48 + $48.
    expect(result.lines.map((l) => [l.kind, l.hours, l.amount])).toEqual([
      ['missed_meal', 1, 48],
      ['missed_rest', 1, 48],
    ]);
    expect(result.total).toBe(96);
  });

  it('pays a nurse sent home on arrival half the shift, between two and four hours', () => {
    // A 12-hour shift: half is 6, capped at 4.
    const twelve = price([
      { kind: 'sent_home', nurseId: 'ana', date: DATE, scheduledHours: 12, hoursWorked: 0 },
    ]);
    expect(twelve.lines[0]).toMatchObject({ kind: 'reporting_pay', hours: 4, amount: 192 });
    // A 3-hour shift: half is 1.5, raised to the 2-hour floor.
    const short = price([
      { kind: 'sent_home', nurseId: 'ana', date: DATE, scheduledHours: 3, hoursWorked: 0 },
    ]);
    expect(short.lines[0]).toMatchObject({ hours: 2, amount: 96 });
  });

  it('pays the hours worked when they are more than the reporting minimum', () => {
    const result = price([
      { kind: 'sent_home', nurseId: 'ana', date: DATE, scheduledHours: 12, hoursWorked: 5 },
    ]);
    expect(result.lines[0]).toMatchObject({ hours: 5, amount: 240 });
  });

  it('pays a missed meal on each of two days, an hour each', () => {
    const next = isoDate('2027-07-07');
    const result = price([
      { kind: 'missed_break', nurseId: 'ana', date: DATE, break: 'meal' },
      { kind: 'missed_break', nurseId: 'ana', date: next, break: 'meal' },
    ]);
    // Labor Code § 226.7 is per workday: 1 h on the 6th + 1 h on the 7th = 2 h × $48 = $96. The
    // once-a-day guard is keyed on the date, so the second day must not be swallowed.
    expect(result.lines.map((l) => [l.kind, l.date, l.hours, l.amount])).toEqual([
      ['missed_meal', DATE, 1, 48],
      ['missed_meal', next, 1, 48],
    ]);
    expect(result.total).toBe(96);
  });

  it('pays four hours to a nurse sent home three hours into a twelve', () => {
    const result = price([
      { kind: 'sent_home', nurseId: 'ana', date: DATE, scheduledHours: 12, hoursWorked: 3 },
    ]);
    // Half of 12 is 6, capped at 4; the larger of 3 worked and 4 owed is 4 h × $48 = $192.
    expect(result.lines[0]).toMatchObject({ kind: 'reporting_pay', hours: 4, amount: 192 });
  });

  it('pays the hours worked when they beat reporting-time pay', () => {
    const result = price([
      { kind: 'sent_home', nurseId: 'ana', date: DATE, scheduledHours: 4, hoursWorked: 3 },
    ]);
    // Half of 4 is 2, already at the 2 h floor; the larger of 3 worked and 2 owed is 3 h × $48 = $144.
    expect(result.lines[0]).toMatchObject({ kind: 'reporting_pay', hours: 3, amount: 144 });
  });

  it('pays a call-back at the call-back premium, and at least the contract minimum', () => {
    const callBack: Differential = {
      id: 'cb',
      unitId: UNIT_ID,
      kind: 'call_back',
      mode: 'multiplier',
      amount: 1.5,
      active: true,
    };
    // Called in for 1.5 hours with a 3-hour minimum: 3 h × $48 × 1.5 = $216.
    const result = price(
      [{ kind: 'call_back', nurseId: 'ana', date: DATE, hoursWorked: 1.5 }],
      ctx([callBack]),
      3,
    );
    expect(result.lines[0]).toMatchObject({ kind: 'call_back', hours: 3, rate: 72, amount: 216 });
  });

  it('adds a flat call-back premium to the base rate', () => {
    const callBack: Differential = {
      id: 'cb',
      unitId: UNIT_ID,
      kind: 'call_back',
      mode: 'flat',
      amount: 10,
      active: true,
    };
    const result = price(
      [{ kind: 'call_back', nurseId: 'ana', date: DATE, hoursWorked: 4 }],
      ctx([callBack]),
    );
    expect(result.lines[0]).toMatchObject({ hours: 4, rate: 58, amount: 232 });
  });

  it('refuses to price a missed break for a nurse the caller did not pass', () => {
    expect(() =>
      priceDayOfEvents(
        [{ kind: 'missed_break', nurseId: 'n-ghost', date: DATE, break: 'meal' }],
        ctx(),
        [],
        { callBackMinimumHours: 0 },
      ),
    ).toThrow(/n-ghost/);
  });

  it('still counts a nurse with no pay rate as unpriced, not $0', () => {
    const result = priceDayOfEvents(
      [{ kind: 'missed_break', nurseId: 'ana', date: DATE, break: 'meal' }],
      { ...ctx(), payRates: [] },
      [ana],
      { callBackMinimumHours: 0 },
    );
    expect(result.lines).toEqual([]);
    expect(result.unpriced).toBe(1);
  });

  it('rounds a sent-home line to the cent', () => {
    const rate: PayRate = { ...RN_RATE, hourlyRate: 48.33 };
    const result = priceDayOfEvents(
      [{ kind: 'sent_home', nurseId: 'ana', date: DATE, scheduledHours: 7, hoursWorked: 0 }],
      { ...ctx(), payRates: [rate] },
      [ana],
      { callBackMinimumHours: 0 },
    );
    // Half of 7 is 3.5 h (inside the 2-4 h band); 3.5 x 48.33 = 169.155, which pays as 169.16.
    expect(result.lines[0]?.amount).toBe(169.16);
    expect(result.total).toBe(169.16);
  });

  it('counts an event for a nurse with no pay rate as unpriced, never as $0 silently', () => {
    const agency = makeNurse({ id: 'ag', role: 'LPN' });
    const result = priceDayOfEvents(
      [{ kind: 'missed_break', nurseId: 'ag', date: DATE, break: 'meal' }],
      ctx(),
      [agency],
      { callBackMinimumHours: 0 },
    );
    expect(result.lines).toEqual([]);
    expect(result.unpriced).toBe(1);
  });
});

describe('a missed break paid at the regular rate (Ferra v. Loews Hollywood Hotel)', () => {
  // A 4-hour day shift, so the week can be exactly 40 hours.
  const DAY_4: ShiftType = {
    ...DAY_8,
    id: 'st-d4',
    name: 'Day 4',
    abbreviation: 'D4',
    durationHours: 4,
  };
  const rn50: PayRate = { ...RN_RATE, hourlyRate: 50 };
  const nightPlus5 = differential('night', 'flat', 5);

  function week(premiumStacking: 'compound' | 'additive' = 'compound') {
    const nurse = makeNurse({ id: 'bea' });
    // The week of Sunday 2026-01-04: three 12-hour nights (36 h) and a 4-hour day, 40 h in all.
    const s = scenario({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-10'),
      nurses: [nurse],
      shiftTypes: [...testShiftTypes, DAY_4],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-04'),
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, NIGHT_12, '2026-01-06'),
        assign(nurse.id, DAY_4, '2026-01-08'),
      ],
    });
    const c: CostContext = {
      ...ctx([nightPlus5]),
      payRates: [rn50],
      premiumStacking,
      breakPremiumRate: 'regular',
    };
    return { nurse, c, cost: costSchedule(s.schedule, c) };
  }

  it('works out the week’s regular rate with the night differential in it', () => {
    // 40 h × $50 = $2,000 base, plus 36 night hours × $5 = $180: $2,180 over 40 h = $54.50.
    const { cost } = week();
    expect(cost.nurses[0]?.regularRates).toEqual([
      { windowStart: isoDate('2026-01-04'), rate: 54.5 },
    ]);
    // Additive stacking changes nothing for a flat differential, and the rate is still reported.
    expect(week('additive').cost.nurses[0]?.regularRates).toEqual([
      { windowStart: isoDate('2026-01-04'), rate: 54.5 },
    ]);
  });

  it('pays a missed meal at $54.50 on the regular rate and $50 on the base rate', () => {
    const { nurse, c } = week();
    const meal: DayOfPayEvent = {
      kind: 'missed_break',
      nurseId: nurse.id,
      date: isoDate('2026-01-08'),
      break: 'meal',
    };
    // The week's rate, worked out above by hand.
    const regularRateFor = (id: string, date: string) =>
      id === nurse.id && date >= '2026-01-04' && date <= '2026-01-10' ? 54.5 : undefined;
    const regular = priceDayOfEvents([meal], c, [nurse], {
      callBackMinimumHours: 0,
      breakPremiumRate: 'regular',
      regularRateFor,
    });
    expect(regular.lines.map((l) => [l.kind, l.rate, l.amount])).toEqual([
      ['missed_meal', 54.5, 54.5],
    ]);
    const base = priceDayOfEvents([meal], c, [nurse], {
      callBackMinimumHours: 0,
      breakPremiumRate: 'base',
      regularRateFor,
    });
    expect(base.lines.map((l) => l.amount)).toEqual([50]);
  });

  it('pays a missed meal at $54.50 under additive stacking too, since the regular rate holds the differentials however overtime stacks', () => {
    // Same week: ($2,000 base + 36 × $5 night = $2,180) / 40 h = $54.50 on every shift, though
    // additive overtime would be paid on the $50 base.
    const { nurse, c, cost } = week('additive');
    expect(cost.assignments.map((a) => a.regularRate)).toEqual([54.5, 54.5, 54.5, 54.5]);
    const regularRateFor = (id: string, date: string) =>
      cost.assignments.find((a) => a.nurseId === id && a.date === date)?.regularRate;
    const result = priceDayOfEvents(
      [{ kind: 'missed_break', nurseId: nurse.id, date: isoDate('2026-01-08'), break: 'meal' }],
      c,
      [nurse],
      { callBackMinimumHours: 0, breakPremiumRate: 'regular', regularRateFor },
    );
    expect(result.lines.map((l) => [l.kind, l.rate, l.amount])).toEqual([
      ['missed_meal', 54.5, 54.5],
    ]);
  });

  it('falls back to the base rate when the week has no regular rate on record', () => {
    const { nurse, c } = week();
    const result = priceDayOfEvents(
      [{ kind: 'missed_break', nurseId: nurse.id, date: isoDate('2026-02-01'), break: 'rest' }],
      c,
      [nurse],
      { callBackMinimumHours: 0, breakPremiumRate: 'regular', regularRateFor: () => undefined },
    );
    expect(result.lines.map((l) => l.amount)).toEqual([50]);
  });
});

describe('the regular rate each shift’s break premium reads', () => {
  it('gives a Saturday day shift the week that ends at 19:00 that evening, and the night after it the new week', () => {
    // Work weeks start Saturday 19:00. The week opened Sat 2026-01-03 19:00 holds a Monday 12-hour
    // day and the Saturday 2026-01-10 07:00–19:00 day: 24 h at $50 = $1,200 / 24 h = $50. The
    // Saturday 19:00 night opens the next week alone: 12 h × ($50 + $5 night) = $660 / 12 h = $55.
    const nurse = makeNurse({ id: 'cy' });
    const s = scenario({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-10'),
        assign(nurse.id, NIGHT_12, '2026-01-10'),
      ],
    });
    const c: CostContext = {
      ...ctx([differential('night', 'flat', 5)]),
      payRates: [{ ...RN_RATE, hourlyRate: 50 }],
      workWeekStartsOn: 6,
      workWeekStartMinute: 19 * 60,
      breakPremiumRate: 'regular',
    };
    const cost = costSchedule(s.schedule, c);
    expect(cost.assignments.map((a) => [a.date, a.shiftTypeId, a.regularRate])).toEqual([
      [isoDate('2026-01-05'), DAY_12.id, 50],
      [isoDate('2026-01-10'), DAY_12.id, 50],
      [isoDate('2026-01-10'), NIGHT_12.id, 55],
    ]);
  });
});

describe('reporting-time pay for a nurse sent home', () => {
  // 07:00 on day 20000 of the wall-clock timeline.
  const S = 20_000 * 1440 + 420;
  const owed = (recordedAtMinute: number, noticeHours = 2) =>
    reportingPayOwed({ shiftStartMinute: S, recordedAtMinute, noticeHours });

  it('owes it to a nurse sent home after she arrived', () => {
    expect(owed(S + 30)).toBe(true);
  });

  it('owes it when the call came 90 minutes before a 07:00 start', () => {
    expect(owed(S - 90)).toBe(true);
  });

  it('owes nothing for a cancellation phoned at 20:00 the evening before', () => {
    // 20:00 to 07:00 is 11 hours, well past the 2-hour notice.
    expect(owed(S - 660)).toBe(false);
  });

  it('owes nothing when told exactly the notice ahead', () => {
    expect(owed(S - 120)).toBe(false);
  });

  it('with no notice set, owes it only once the shift has begun', () => {
    expect(owed(S - 1, 0)).toBe(false);
    expect(owed(S, 0)).toBe(false);
    expect(owed(S + 1, 0)).toBe(true);
  });
});
