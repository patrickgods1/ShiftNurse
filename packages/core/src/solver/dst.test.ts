import { beforeEach, describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import {
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
} from '../testing/fixtures.js';
import { solve } from './solver.js';

beforeEach(() => {
  resetFixtureCounters();
});

describe('generating across the spring-forward weekend', () => {
  it('builds a fortnight over 2026-03-08 with no rule broken', () => {
    const nurses = Array.from({ length: 10 }, () => makeNurse({ isChargeEligible: true }));
    const input = solveInputFrom({
      nurses,
      shiftTypes: [DAY_12, NIGHT_12],
      startDate: isoDate('2026-03-01'),
      endDate: isoDate('2026-03-14'),
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 2),
        ...coverageAllWeek(NIGHT_12, 'RN', 2),
      ],
    });
    const report = solve(input, { seed: 1, maxIterations: 1500 });
    expect(report.assignments.length).toBeGreaterThan(0);
    expect(report.hardViolations).toEqual([]);
  });
});
