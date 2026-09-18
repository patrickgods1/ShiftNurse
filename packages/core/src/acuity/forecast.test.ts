import { describe, expect, it } from 'vitest';
import { addDays, isoDate } from '../domain/time.js';
import {
  census,
  coverageAllWeek,
  DAY_12,
  NIGHT_12,
  TIER_HIGH,
  TIER_ROUTINE,
  testAcuityTiers,
  testRatioRules,
} from '../testing/fixtures.js';
import { deriveDemand } from './demand.js';
import { backtest, proposeCensus, validateAcuityMix } from './forecast.js';

// 2026-09-06 is a Sunday.
const SUNDAY = isoDate('2026-09-06');

/** Same-weekday history: one row per week back from `anchor`, actual census given. */
function weeklyHistory(anchor: string, actuals: readonly number[], shiftType = DAY_12) {
  return actuals.map((actual, i) => {
    const date = addDays(isoDate(anchor), -7 * (i + 1));
    return census(
      date,
      shiftType,
      {
        [TIER_ROUTINE.id]: Math.round(actual * 0.75),
        [TIER_HIGH.id]: actual - Math.round(actual * 0.75),
      },
      {
        actualCensus: actual,
        actualAcuityMix: { [TIER_ROUTINE.id]: actual - 4, [TIER_HIGH.id]: 4 },
      },
    );
  });
}

describe('census proposal', () => {
  it('averages the same weekday and shift over recent weeks: (20+22+24+26)/4 = 23', () => {
    const history = weeklyHistory(SUNDAY, [20, 22, 24, 26]);
    const [p] = proposeCensus(history, [{ date: SUNDAY, shiftTypeId: DAY_12.id }], {
      lookbackWeeks: 8,
      seasonal: false,
    });
    expect(p!.projectedCensus).toBe(23);
    expect(p!.basis.samples).toBe(4);
  });

  it('ignores other weekdays and other shifts — a busy Monday night says nothing about Sunday days', () => {
    const history = [
      ...weeklyHistory(SUNDAY, [20, 20]),
      ...weeklyHistory(addDays(SUNDAY, 1), [40, 40]), // Mondays
      ...weeklyHistory(SUNDAY, [40, 40], NIGHT_12), // Sunday nights
    ];
    const [p] = proposeCensus(history, [{ date: SUNDAY, shiftTypeId: DAY_12.id }], {
      lookbackWeeks: 8,
      seasonal: false,
    });
    expect(p!.projectedCensus).toBe(20);
  });

  it('uses the actual census when recorded and falls back to the projection otherwise', () => {
    const withActual = weeklyHistory(SUNDAY, [30]);
    const noActual = census(addDays(SUNDAY, -14), DAY_12, { [TIER_ROUTINE.id]: 10 });
    const [p] = proposeCensus(
      [...withActual, noActual],
      [{ date: SUNDAY, shiftTypeId: DAY_12.id }],
      {
        lookbackWeeks: 8,
        seasonal: false,
      },
    );
    expect(p!.projectedCensus).toBe(20); // (30 + 10) / 2
  });

  it('only looks back the configured number of weeks', () => {
    const history = weeklyHistory(SUNDAY, [10, 10, 90, 90]);
    const [p] = proposeCensus(history, [{ date: SUNDAY, shiftTypeId: DAY_12.id }], {
      lookbackWeeks: 2,
      seasonal: false,
    });
    expect(p!.projectedCensus).toBe(10);
  });

  it("scales by last year's seasonal index: the same weeks a year ago ran above their annual mean", () => {
    // Recent weeks: flat 20. Last year, going back weekly from the anniversary of the target
    // date: 24 for the anniversary and the two weeks before it, 20 for every other week.
    const recent = weeklyHistory(SUNDAY, [20, 20, 20, 20]);
    const lastYear: ReturnType<typeof census>[] = [];
    for (let w = 0; w < 52; w++) {
      const date = addDays(SUNDAY, -364 - 7 * w);
      const near = w <= 2;
      lastYear.push(
        census(
          date,
          DAY_12,
          { [TIER_ROUTINE.id]: near ? 24 : 20 },
          { actualCensus: near ? 24 : 20 },
        ),
      );
    }
    const [p] = proposeCensus(
      [...recent, ...lastYear],
      [{ date: SUNDAY, shiftTypeId: DAY_12.id }],
      {
        lookbackWeeks: 4,
        seasonal: true,
      },
    );
    // Near window (anniversary ±2 weeks): 3 rows at 24 → 24. Annual window (anniversary
    // ±26 weeks): those 3 plus 24 rows at 20 → 552/27 = 20.444. Index = 24/20.444 = 1.174.
    expect(p!.basis.seasonalIndex).toBeCloseTo(1.174, 3);
    expect(p!.projectedCensus).toBe(23); // round(20 × 1.174) = round(23.48)
  });

  it('distributes the acuity mix by historical proportion so it sums to the census', () => {
    // Actual mixes: routine = actual − 4, high = 4 → at census 24, high ≈ 4/24 of patients.
    const history = weeklyHistory(SUNDAY, [24, 24, 24, 24]);
    const [p] = proposeCensus(history, [{ date: SUNDAY, shiftTypeId: DAY_12.id }], {
      lookbackWeeks: 8,
      seasonal: false,
    });
    expect(p!.projectedCensus).toBe(24);
    expect(p!.acuityMix).toEqual({ [TIER_ROUTINE.id]: 20, [TIER_HIGH.id]: 4 });
    expect(Object.values(p!.acuityMix).reduce((a, b) => a + b, 0)).toBe(24);
  });

  it('returns no proposal when there is no history for that weekday and shift', () => {
    const proposals = proposeCensus([], [{ date: SUNDAY, shiftTypeId: DAY_12.id }], {
      lookbackWeeks: 8,
      seasonal: false,
    });
    expect(proposals).toEqual([]);
  });
});

describe('acuity mix validation', () => {
  it('accepts a mix that sums to the census', () => {
    expect(validateAcuityMix(24, { [TIER_ROUTINE.id]: 20, [TIER_HIGH.id]: 4 })).toEqual([]);
  });

  it('names the gap when the mix does not add up: 20 + 3 ≠ 24', () => {
    const problems = validateAcuityMix(24, { [TIER_ROUTINE.id]: 20, [TIER_HIGH.id]: 3 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('23');
    expect(problems[0]).toContain('24');
  });

  it('rejects negative and fractional patient counts', () => {
    const problems = validateAcuityMix(3, { [TIER_ROUTINE.id]: -1, [TIER_HIGH.id]: 4.5 });
    expect(problems.map((p) => p.includes('-1') || p.includes('4.5')).filter(Boolean)).toHaveLength(
      2,
    );
  });
});

describe('forecast back-test', () => {
  it('scores recorded forecasts against actuals: errors of +2, −1, 0 → MAE 1, bias +0.33', () => {
    const rows = [
      census('2026-08-02', DAY_12, { [TIER_ROUTINE.id]: 22 }, { actualCensus: 20 }),
      census('2026-08-09', DAY_12, { [TIER_ROUTINE.id]: 19 }, { actualCensus: 20 }),
      census('2026-08-16', DAY_12, { [TIER_ROUTINE.id]: 20 }, { actualCensus: 20 }),
      census('2026-08-23', DAY_12, { [TIER_ROUTINE.id]: 99 }), // no actual: excluded
    ];
    const result = backtest(rows, { lookbackWeeks: 8, seasonal: false });
    expect(result.recorded.samples).toBe(3);
    expect(result.recorded.meanAbsoluteError).toBeCloseTo(1, 6);
    expect(result.recorded.bias).toBeCloseTo(1 / 3, 6);
    expect(result.recorded.meanAbsolutePercentageError).toBeCloseTo(5, 6); // (10% + 5% + 0%) / 3
  });

  it('scores what the forecaster would have said using only earlier history', () => {
    // Sundays at 20, 20, 20, then 26. The model, seeing three 20s, proposes 20 for the 4th:
    // error 6. For the earlier Sundays it has less history; the first has none and is skipped.
    const rows = weeklyHistory(addDays(SUNDAY, 7), [26, 20, 20, 20]);
    const result = backtest(rows, { lookbackWeeks: 8, seasonal: false });
    expect(result.model.samples).toBe(3);
    // Errors: 2nd Sunday sees [20] → 20 vs 20 = 0; 3rd sees [20,20] → 0; 4th sees [20,20,20] → 20 vs 26 = −6.
    expect(result.model.meanAbsoluteError).toBeCloseTo(2, 6);
    expect(result.model.bias).toBeCloseTo(-2, 6);
  });

  it('breaks the scores down per shift type', () => {
    const rows = [
      census('2026-08-02', DAY_12, { [TIER_ROUTINE.id]: 25 }, { actualCensus: 20 }),
      census('2026-08-02', NIGHT_12, { [TIER_ROUTINE.id]: 20 }, { actualCensus: 20 }),
    ];
    const result = backtest(rows, { lookbackWeeks: 8, seasonal: false });
    expect(result.byShiftType[DAY_12.id]!.recorded.meanAbsoluteError).toBe(5);
    expect(result.byShiftType[NIGHT_12.id]!.recorded.meanAbsoluteError).toBe(0);
  });
});

describe('acuity-driven demand', () => {
  it('a high-acuity mix raises required RNs above the coverage floor: 10 high @1:2 = 5 RNs vs floor 4', () => {
    const table = deriveDemand([SUNDAY], {
      shiftTypes: [DAY_12],
      acuityTiers: testAcuityTiers,
      ratioRules: testRatioRules,
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 4, 4),
      censusForecasts: [census(SUNDAY, DAY_12, { [TIER_HIGH.id]: 10 })],
    });
    const rn = table.get(SUNDAY, DAY_12.id)!.byRole.RN;
    expect(rn.coverageFloorMin).toBe(4);
    expect(rn.ratioDerived).toBe(5);
    expect(rn.minCount).toBe(5);
    expect(rn.bindingConstraint).toBe('ratio');
  });

  it('the same census at routine acuity stays on the floor: 10 routine @1:5 = 2 RNs, floor 4 binds', () => {
    const table = deriveDemand([SUNDAY], {
      shiftTypes: [DAY_12],
      acuityTiers: testAcuityTiers,
      ratioRules: testRatioRules,
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 4, 4),
      censusForecasts: [census(SUNDAY, DAY_12, { [TIER_ROUTINE.id]: 10 })],
    });
    const rn = table.get(SUNDAY, DAY_12.id)!.byRole.RN;
    expect(rn.ratioDerived).toBe(2);
    expect(rn.minCount).toBe(4);
    expect(rn.bindingConstraint).toBe('coverage_floor');
  });
});
