/**
 * The overtime option Resolve offers is priced with the unit's own pay settings. Before the
 * settings reached the conflicts engine, every unit was priced as compound with the clock split.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import type { SolveCostInput } from '../solver/types.js';
import {
  assign,
  coverage,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  solveInputFrom,
} from '../testing/fixtures.js';
import { detectConflicts } from './detect.js';
import { generateResolutions } from './resolve.js';

beforeEach(() => {
  resetFixtureCounters();
});

const SAT = '2026-01-10';

/** Ana has 36h Mon–Wed; the Saturday night is the only way to cover the floor with her. */
function overtimeDelta(settings: Partial<SolveCostInput>): number {
  const priya = makeNurse({ firstName: 'Priya', isChargeEligible: true });
  const ana = makeNurse({ firstName: 'Ana', isChargeEligible: true });
  const input = solveInputFrom({
    startDate: isoDate('2026-01-05'),
    endDate: isoDate('2026-01-17'),
    nurses: [priya, ana],
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(SAT)),
      ...['2026-01-05', '2026-01-06', '2026-01-07'].map((d) =>
        coverage(DAY_12, 'RN', 1, 1, null, isoDate(d)),
      ),
    ],
    assignments: [
      assign(ana.id, DAY_12, '2026-01-05'),
      assign(ana.id, DAY_12, '2026-01-06'),
      assign(ana.id, DAY_12, '2026-01-07'),
    ],
    cost: {
      payRates: [payRate(50)],
      differentials: [differential('night', 'flat', 4)],
      overtimeRules: [overtimeRule('weekly', 40)],
      ...settings,
    },
  });
  const resolutions = generateResolutions(input, detectConflicts(input));
  const option = resolutions.find((r) => r.kind === 'authorize_overtime');
  return option!.impact.cost.delta;
}

describe('pricing the overtime option with the unit’s pay settings', () => {
  it('prices additive premiums as a share of base pay', () => {
    // The night is $648 (12 × (50 + 4)). By the clock 1h of it is past 40; additive overtime is
    // 0.5 × $50 base × 1h = $25. 648 + 25 = 673 (the compound rate would give 673.24).
    expect(overtimeDelta({ premiumStacking: 'additive' })).toBe(673);
  });

  it('counts the whole night in the week it starts when the unit says so', () => {
    // Start-of-shift: 36 + 12 = 48h, so 8h overtime. Regular rate (36 × 50 + 648) / 48 = $51;
    // premium 8 × 0.5 × 51 = $204. 648 + 204 = 852.
    expect(overtimeDelta({ overtimeWindowAttribution: 'start' })).toBe(852);
  });
});
