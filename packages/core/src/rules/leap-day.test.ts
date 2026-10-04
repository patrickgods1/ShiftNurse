/**
 * The pay period Sun 2028-02-27 to Sat 2028-03-11 has 14 days and holds Tue 2028-02-29. Contracted
 * hours are per pay period, so the extra calendar day must not shift the 72h target.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { datesInRange, isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  resetFixtureCounters,
  scenario,
  testUnit,
} from '../testing/fixtures.js';
import { evaluateSchedule } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

const unit = { ...testUnit, payPeriodDays: 14, payPeriodAnchor: isoDate('2028-02-27') };
const START = isoDate('2028-02-27');
const END = isoDate('2028-03-11');

function codesFor(days: string[]) {
  const nurse = makeNurse(); // 72h contracted per pay period
  const s = scenario({
    unit,
    startDate: START,
    endDate: END,
    nurses: [nurse],
    assignments: days.map((d) => assign(nurse.id, DAY_12, d)),
  });
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
    (v) => v.code === 'under_contracted_hours' || v.code === 'over_contracted_hours',
  );
}

describe('a pay period that holds a leap day', () => {
  it('has fourteen dates including February 29th', () => {
    const dates = datesInRange(START, END);
    expect(dates).toHaveLength(14);
    expect(dates).toContain('2028-02-29');
  });

  it('does not flag a full-timer scheduled six twelves, one of them on the leap day', () => {
    const days = [
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-05',
      '2028-03-07',
      '2028-03-09',
    ];
    expect(codesFor(days)).toEqual([]);
  });

  it('flags five twelves as twelve hours short of the contract', () => {
    const found = codesFor(['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-05', '2028-03-07']);
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('under_contracted_hours');
    expect(found[0]?.details?.scheduledHours).toBe(60);
    expect(found[0]?.details?.deltaHours).toBe(-12);
  });
});
