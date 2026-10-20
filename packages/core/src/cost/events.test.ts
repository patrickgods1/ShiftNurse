/**
 * Day-of pay worked by hand at the $48 RN rate the other cost tests use.
 */

import { describe, expect, it } from 'vitest';
import type { Differential, PayRate } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import { makeNurse, testUnit, UNIT_ID } from '../testing/fixtures.js';
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
