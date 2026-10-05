/**
 * Day-of pay worked by hand at the $48 RN rate the other cost tests use.
 */

import { describe, expect, it } from 'vitest';
import type { Differential, PayRate } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import { makeNurse, testUnit, UNIT_ID } from '../testing/fixtures.js';
import { type DayOfPayEvent, priceDayOfEvents } from './events.js';
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
