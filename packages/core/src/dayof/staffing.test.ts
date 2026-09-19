import { describe, expect, it } from 'vitest';
import type { DemandInputs } from '../acuity/demand.js';
import type { Assignment } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import {
  assign,
  census,
  coverageAllWeek,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  TIER_ROUTINE,
  testAcuityTiers,
  testRatioRules,
} from '../testing/fixtures.js';
import { checkStaffing, type StaffingCheckInput, shiftsAround } from './staffing.js';

// A plain Monday; nothing about the day itself matters to these tests.
const DATE = isoDate('2026-09-07');

function baseDemand(overrides: Partial<DemandInputs> = {}): DemandInputs {
  return {
    shiftTypes: [DAY_12],
    acuityTiers: testAcuityTiers,
    ratioRules: testRatioRules,
    coverageRequirements: [],
    censusForecasts: [],
    ...overrides,
  };
}

describe('checkStaffing', () => {
  it('uses the forecast until an actual census is entered', () => {
    resetFixtureCounters();
    // 20 routine patients @ RN 1:5 -> ceil(20/5) = 4 RNs, above the floor of 2.
    const forecast = census(DATE, DAY_12, { [TIER_ROUTINE.id]: 20 });
    const nurses = [makeNurse(), makeNurse(), makeNurse(), makeNurse()];
    const assignments: Assignment[] = nurses.map((n) => assign(n.id, DAY_12, DATE));

    const input: StaffingCheckInput = {
      date: DATE,
      shiftTypes: [DAY_12],
      nurses,
      assignments,
      demand: baseDemand({
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2, 2),
        censusForecasts: [forecast],
      }),
    };

    const [check] = checkStaffing(input);
    expect(check).toBeDefined();
    expect(check?.basis).toBe('forecast');
    expect(check?.census).toBe(20);
    expect(check?.byRole.RN.required).toBe(4);
    expect(check?.byRole.RN.staffed).toBe(4);
    expect(check?.byRole.RN.shortfall).toBe(0);
    expect(check?.short).toBe(false);
  });

  it('re-derives the requirement from the actual census once it is entered', () => {
    resetFixtureCounters();
    // Forecast said 20 routine (R = ceil(20/5) = 4 RNs). Actual is 30 routine:
    // ceil(30/5) = 6 = R + 2.
    const forecast = census(
      DATE,
      DAY_12,
      { [TIER_ROUTINE.id]: 20 },
      { actualCensus: 30, actualAcuityMix: { [TIER_ROUTINE.id]: 30 } },
    );

    const input: StaffingCheckInput = {
      date: DATE,
      shiftTypes: [DAY_12],
      nurses: [],
      assignments: [],
      demand: baseDemand({
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2, 2),
        censusForecasts: [forecast],
      }),
    };

    const [check] = checkStaffing(input);
    expect(check?.basis).toBe('actual');
    expect(check?.census).toBe(30);
    expect(check?.byRole.RN.required).toBe(6);
  });

  it('flags a ratio breach, not just a floor shortfall, when the actual census outruns the roster', () => {
    resetFixtureCounters();
    // Floor is 2 RNs; the actual census of 30 routine patients demands ceil(30/5) = 6, so the
    // binding constraint is the ratio, not the floor. Only 2 RNs are on the shift.
    const forecast = census(
      DATE,
      DAY_12,
      { [TIER_ROUTINE.id]: 20 },
      { actualCensus: 30, actualAcuityMix: { [TIER_ROUTINE.id]: 30 } },
    );
    const nurses = [makeNurse(), makeNurse()];
    const assignments: Assignment[] = nurses.map((n) => assign(n.id, DAY_12, DATE));

    const input: StaffingCheckInput = {
      date: DATE,
      shiftTypes: [DAY_12],
      nurses,
      assignments,
      demand: baseDemand({
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2, 2),
        censusForecasts: [forecast],
      }),
    };

    const [check] = checkStaffing(input);
    expect(check?.byRole.RN.bindingConstraint).toBe('ratio');
    expect(check?.short).toBe(true);
    expect(check?.ratioBreached).toBe(true);
  });

  it('a shortfall against the coverage floor alone is not a ratio breach', () => {
    resetFixtureCounters();
    // No census entered at all: ratio-derived is 0, so the floor of 5 is the sole binding
    // constraint. Only 2 RNs are on the shift, which is a floor shortfall, not a ratio one.
    const nurses = [makeNurse(), makeNurse()];
    const assignments: Assignment[] = nurses.map((n) => assign(n.id, DAY_12, DATE));

    const input: StaffingCheckInput = {
      date: DATE,
      shiftTypes: [DAY_12],
      nurses,
      assignments,
      demand: baseDemand({
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 5, 5),
      }),
    };

    const [check] = checkStaffing(input);
    expect(check?.byRole.RN.bindingConstraint).toBe('coverage_floor');
    expect(check?.short).toBe(true);
    expect(check?.ratioBreached).toBe(false);
  });

  it('counts only nurses of the role being checked', () => {
    resetFixtureCounters();
    const forecast = census(DATE, DAY_12, { [TIER_ROUTINE.id]: 20 });
    const rnNurses = [makeNurse(), makeNurse(), makeNurse(), makeNurse()];
    const lpnNurse = makeNurse({ role: 'LPN' });
    const nurses = [...rnNurses, lpnNurse];
    const assignments: Assignment[] = nurses.map((n) => assign(n.id, DAY_12, DATE));

    const input: StaffingCheckInput = {
      date: DATE,
      shiftTypes: [DAY_12],
      nurses,
      assignments,
      demand: baseDemand({
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2, 2),
        censusForecasts: [forecast],
      }),
    };

    const [check] = checkStaffing(input);
    expect(check?.byRole.RN.staffed).toBe(4);
  });

  it('falls back to the coverage floor when no census exists', () => {
    resetFixtureCounters();
    const nurses = [makeNurse(), makeNurse(), makeNurse()];
    const assignments: Assignment[] = nurses.map((n) => assign(n.id, DAY_12, DATE));

    const input: StaffingCheckInput = {
      date: DATE,
      shiftTypes: [DAY_12],
      nurses,
      assignments,
      demand: baseDemand({
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 3, 3),
      }),
    };

    const [check] = checkStaffing(input);
    expect(check?.basis).toBe('floor');
    expect(check?.census).toBe(0);
  });

  it('throws on an assignment for a nurse it does not know', () => {
    resetFixtureCounters();
    const assignments: Assignment[] = [assign('ghost-nurse', DAY_12, DATE)];

    const input: StaffingCheckInput = {
      date: DATE,
      shiftTypes: [DAY_12],
      nurses: [],
      assignments,
      demand: baseDemand({
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      }),
    };

    expect(() => checkStaffing(input)).toThrow('Unknown nurse ghost-nurse');
  });
});

describe('shiftsAround', () => {
  const shiftTypes = [DAY_12, NIGHT_12, DAY_8, EVENING_8, NIGHT_8, ON_CALL];
  const today = isoDate('2026-09-10');
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  it('at 03:00 the running night shift is yesterday’s', () => {
    const result = shiftsAround(shiftTypes, today, 3 * 60);

    expect(result.current).toContainEqual({ date: yesterday, shiftTypeId: NIGHT_12.id });
    // NIGHT_8 starts 23:00 yesterday, 8h duration -> ends 07:00 today, so it is also current.
    expect(result.current).toContainEqual({ date: yesterday, shiftTypeId: NIGHT_8.id });
    expect(result.current.every((slot) => slot.date === yesterday)).toBe(true);

    // DAY_12 and DAY_8 both start 07:00 today; DAY_12 has the lower sortOrder (1 vs 3).
    expect(result.next).toEqual({ date: today, shiftTypeId: DAY_12.id });
  });

  it('at 10:00 both the 12-hour and the 8-hour day shifts are running', () => {
    const result = shiftsAround(shiftTypes, today, 10 * 60);

    expect(result.current).toEqual(
      expect.arrayContaining([
        { date: today, shiftTypeId: DAY_12.id },
        { date: today, shiftTypeId: DAY_8.id },
      ]),
    );
    expect(result.current).toHaveLength(2);
    expect(result.next).toEqual({ date: today, shiftTypeId: EVENING_8.id });
  });

  it('after the last start of the day, next is tomorrow’s first shift', () => {
    const result = shiftsAround(shiftTypes, today, 23 * 60 + 30);

    // DAY_12 and DAY_8 tie at 07:00 tomorrow; DAY_12 wins on sortOrder.
    expect(result.next).toEqual({ date: tomorrow, shiftTypeId: DAY_12.id });
  });

  it('a shift starting exactly now is current, not next', () => {
    const result = shiftsAround(shiftTypes, today, 7 * 60);

    expect(result.current).toContainEqual({ date: today, shiftTypeId: DAY_12.id });
  });
});
