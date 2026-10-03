import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_COUNTERS } from '../fairness/types.js';
import type { Violation } from '../rules/types.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { digestSchedule } from './digest.js';

beforeEach(() => {
  resetFixtureCounters();
});

const counters = (nightShifts: number, weekendsWorked: number, undesirableShifts = 0) => ({
  ...EMPTY_COUNTERS,
  nightShifts,
  weekendsWorked,
  undesirableShifts,
});

const flag = (code: Violation['code'], nurseId: string): Violation => ({
  ruleId: 'r',
  ruleName: 'r',
  severity: 'soft',
  code,
  message: '',
  nurseIds: [nurseId],
  dates: [],
  assignmentIds: [],
});

describe('a schedule in the numbers a manager compares', () => {
  it('spreads nights and weekends over the contracted staff, fewest to most', () => {
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse()];
    const digest = digestSchedule({
      nurses: [a!, b!, c!],
      counters: new Map([
        [a!.id, counters(2, 1)],
        [b!.id, counters(9, 3)],
        [c!.id, counters(5, 2)],
      ]),
      violations: [],
    });
    expect(digest.nights).toEqual({ min: 2, max: 9 });
    expect(digest.weekends).toEqual({ min: 1, max: 3 });
  });

  it('reads the night spread among nurses who work nights, so day staff do not make it 0–18', () => {
    const [days, rotating, nights] = [makeNurse(), makeNurse(), makeNurse()];
    const digest = digestSchedule({
      nurses: [days, rotating, nights],
      counters: new Map([
        [days.id, counters(0, 2)],
        [rotating.id, counters(4, 2)],
        [nights.id, counters(18, 3)],
      ]),
      violations: [],
    });
    expect(digest.nights).toEqual({ min: 4, max: 18 });
    // Weekends fall on everyone, day staff included.
    expect(digest.weekends).toEqual({ min: 2, max: 3 });
  });

  it('leaves per-diem staff out of the spread: picking up no nights is not unfair to them', () => {
    const fullTime = makeNurse();
    const perDiem = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const digest = digestSchedule({
      nurses: [fullTime, perDiem],
      counters: new Map([[fullTime.id, counters(4, 2)]]),
      violations: [],
    });
    expect(digest.nights).toEqual({ min: 4, max: 4 });
  });

  it('counts quick flips from nights to days, and each nurse under contract once', () => {
    const [a, b] = [makeNurse(), makeNurse()];
    const digest = digestSchedule({
      nurses: [a!, b!],
      counters: new Map([
        [a!.id, counters(3, 1, 2)],
        [b!.id, counters(3, 1, 1)],
      ]),
      violations: [
        flag('short_recovery_after_nights', a!.id),
        flag('short_recovery_after_nights', a!.id),
        flag('under_contracted_hours', b!.id),
        flag('under_contracted_hours', b!.id),
        flag('works_during_pending_time_off', b!.id),
      ],
    });
    expect(digest.onDaysAskedOff).toBe(1);
    expect(digest.quickFlips).toBe(2);
    expect(digest.nursesUnderContract).toBe(1);
    expect(digest.againstPreference).toBe(3);
  });

  it('reads an empty roster as zeros, not as a crash', () => {
    expect(digestSchedule({ nurses: [], counters: new Map(), violations: [] })).toEqual({
      nights: { min: 0, max: 0 },
      weekends: { min: 0, max: 0 },
      quickFlips: 0,
      nursesUnderContract: 0,
      againstPreference: 0,
      onDaysAskedOff: 0,
    });
  });
});
