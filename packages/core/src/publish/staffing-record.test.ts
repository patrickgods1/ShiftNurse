import { describe, expect, it } from 'vitest';
import type { DemandInputs } from '../acuity/demand.js';
import { checkStaffing } from '../dayof/staffing.js';
import type { ShiftStaffingCheck } from '../dayof/types.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  census,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  TIER_ROUTINE,
  testAcuityTiers,
  testRatioRules,
} from '../testing/fixtures.js';
import { buildStaffingRecord } from './staffing-record.js';

const DATE = isoDate('2026-09-07');

function demandFor(shiftTypes: DemandInputs['shiftTypes'], overrides: Partial<DemandInputs> = {}) {
  return {
    shiftTypes,
    acuityTiers: testAcuityTiers,
    ratioRules: testRatioRules,
    coverageRequirements: [],
    censusForecasts: [],
    ...overrides,
  } satisfies DemandInputs;
}

describe('buildStaffingRecord', () => {
  it('records the shortfall when a floated nurse and an uncovered call-off leave one RN on a census of 20', () => {
    resetFixtureCounters();
    // Actual census 20 routine at RN 1:5 -> 20 / 5 = 4 RNs required (floor of 2 is lower).
    // Three RNs were scheduled; one was floated off (not counted by checkStaffing) and one
    // called off with nobody covering (the caller removes that row), so 1 actual.
    // Variance = 1 - 4 = -3.
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse()];
    const nurses = [a!, b!, c!];
    const kept = assign(a!.id, DAY_12, DATE);
    const floated = { ...assign(b!.id, DAY_12, DATE), floatedTo: 'other-unit' };
    const calledOff = assign(c!.id, DAY_12, DATE);
    const countable = [kept, floated, calledOff].filter((x) => x !== calledOff);
    const forecast = census(
      DATE,
      DAY_12,
      { [TIER_ROUTINE.id]: 18 },
      { actualCensus: 20, actualAcuityMix: { [TIER_ROUTINE.id]: 20 } },
    );
    const demand = demandFor([DAY_12], {
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2, 2),
      censusForecasts: [forecast],
    });
    const checks = checkStaffing({
      date: DATE,
      shiftTypes: [DAY_12],
      nurses,
      assignments: countable,
      demand,
    });

    const rows = buildStaffingRecord([{ date: DATE, shiftTypes: [DAY_12], checks }]);

    expect(rows.map((r) => r.role)).toEqual(['RN', 'LPN', 'CNA']);
    expect(rows[0]).toEqual({
      date: DATE,
      shiftTypeId: DAY_12.id,
      shiftTypeName: DAY_12.name,
      role: 'RN',
      required: 4,
      actual: 1,
      variance: -3,
      basis: 'actual',
      census: 20,
    });
  });

  it('leaves the on-call standby and a shift that runs inside another off the record', () => {
    resetFixtureCounters();
    const inner = { ...DAY_12, id: 'st-inner', sortOrder: 9, withinShiftTypeId: DAY_12.id };
    const types = [DAY_12, ON_CALL, inner];
    const checks = checkStaffing({
      date: DATE,
      shiftTypes: types,
      nurses: [],
      assignments: [],
      demand: demandFor(types, { coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1) }),
    });
    expect(checks.length).toBe(3);

    const rows = buildStaffingRecord([{ date: DATE, shiftTypes: types, checks }]);

    expect(new Set(rows.map((r) => r.shiftTypeId))).toEqual(new Set([DAY_12.id]));
  });

  it('lists days in date order and shifts in the unit order, three roles each', () => {
    resetFixtureCounters();
    const types = [DAY_12, NIGHT_12];
    const next = isoDate('2026-09-08');
    const mk = (date: typeof DATE) =>
      checkStaffing({
        date,
        shiftTypes: types,
        nurses: [],
        assignments: [],
        demand: demandFor(types, { coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1) }),
      });

    const rows = buildStaffingRecord([
      { date: DATE, shiftTypes: types, checks: mk(DATE) },
      { date: next, shiftTypes: types, checks: mk(next) },
    ]);

    expect(rows.map((r) => `${r.date}/${r.shiftTypeId}/${r.role}`)).toEqual([
      `${DATE}/${DAY_12.id}/RN`,
      `${DATE}/${DAY_12.id}/LPN`,
      `${DATE}/${DAY_12.id}/CNA`,
      `${DATE}/${NIGHT_12.id}/RN`,
      `${DATE}/${NIGHT_12.id}/LPN`,
      `${DATE}/${NIGHT_12.id}/CNA`,
      `${next}/${DAY_12.id}/RN`,
      `${next}/${DAY_12.id}/LPN`,
      `${next}/${DAY_12.id}/CNA`,
      `${next}/${NIGHT_12.id}/RN`,
      `${next}/${NIGHT_12.id}/LPN`,
      `${next}/${NIGHT_12.id}/CNA`,
    ]);
  });

  it('adds the pooled RN and LPN line after the three roles when a licensed ratio governs', () => {
    resetFixtureCounters();
    // Hand-built check: pool needs 6 licensed, 4 on the floor -> variance -2.
    const zero = { required: 0, staffed: 0, shortfall: 0, bindingConstraint: 'coverage_floor' };
    const check: ShiftStaffingCheck = {
      date: DATE,
      shiftTypeId: DAY_12.id,
      basis: 'forecast',
      census: 30,
      byRole: {
        RN: { role: 'RN', ...zero, required: 3, staffed: 2, shortfall: 1 },
        LPN: { role: 'LPN', ...zero, staffed: 2 },
        CNA: { role: 'CNA', ...zero },
      } as ShiftStaffingCheck['byRole'],
      licensed: { required: 6, staffed: 4, shortfall: 2 },
      short: true,
      ratioBreached: true,
    };

    const rows = buildStaffingRecord([{ date: DATE, shiftTypes: [DAY_12], checks: [check] }]);

    expect(rows.map((r) => r.role)).toEqual(['RN', 'LPN', 'CNA', 'licensed']);
    expect(rows[3]).toMatchObject({ required: 6, actual: 4, variance: -2, census: 30 });
    expect(rows[1]).toMatchObject({ required: 0, actual: 2, variance: 2 });
  });

  it('refuses a check for a shift type the day does not list', () => {
    resetFixtureCounters();
    const checks = checkStaffing({
      date: DATE,
      shiftTypes: [DAY_12],
      nurses: [],
      assignments: [],
      demand: demandFor([DAY_12]),
    });
    expect(() => buildStaffingRecord([{ date: DATE, shiftTypes: [NIGHT_12], checks }])).toThrow(
      /shift type/i,
    );
  });
});
