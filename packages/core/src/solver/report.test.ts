import { beforeEach, describe, expect, it } from 'vitest';

import type { Nurse } from '../domain/entities.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { scoreAssignments } from './report.js';
import { solve } from './solver.js';
import type { SolveInput } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** Two RNs on every day and night shift, 2026-01-04 to 2026-01-17 (the fixture default). */
function twoPerShift(nurses: Nurse[], extra: Partial<SolveScenarioOptions> = {}): SolveInput {
  return solveInputFrom({
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 2),
      ...coverageAllWeek(NIGHT_12, 'RN', 2),
    ],
    ...extra,
  });
}

function fullTimers(count: number): Nurse[] {
  return Array.from({ length: count }, (_, i) => makeNurse({ isChargeEligible: i % 2 === 0 }));
}

describe('scoring a schedule the manager already has', () => {
  it('reads an empty draft as every floor short', () => {
    // 14 days × (day + night) = 28 shifts, each 2 RNs short.
    const score = scoreAssignments(twoPerShift(fullTimers(10)), []);
    expect(score.unfilled).toHaveLength(28);
    expect(score.unfilled.every((slot) => slot.shortfall === 2)).toBe(true);
  });

  it('judges a generated schedule exactly as Generate reported it', () => {
    const input = twoPerShift(fullTimers(10));
    const report = solve(input, { seed: 3, maxIterations: 3000 });
    const score = scoreAssignments(input, report.assignments);
    expect(score.objective).toEqual(report.objective);
    expect(score.unfilled).toEqual(report.unfilled);
    expect(score.hardViolations).toEqual(report.hardViolations);
    expect(score.softViolations).toEqual(report.softViolations);
    expect(score.fairness).toEqual(report.fairness);
  });

  it('counts a hand-placed shift during approved leave that Generate would never place', () => {
    const nurses = fullTimers(10);
    const onLeave = nurses[0]!;
    const input = twoPerShift(nurses, {
      timeOff: [timeOff(onLeave.id, '2026-01-06', '2026-01-08')],
    });
    const score = scoreAssignments(input, [assign(onLeave.id, DAY_12, '2026-01-07')]);
    const leave = score.hardViolations.filter((v) => v.code === 'works_during_approved_time_off');
    expect(leave).toHaveLength(1);
    expect(leave[0]!.nurseIds).toEqual([onLeave.id]);
  });

  it('treats unlocked draft shifts as part of the schedule rather than throwing them away', () => {
    const nurses = fullTimers(10);
    const input = twoPerShift(nurses);
    const draft = [
      assign(nurses[0]!.id, DAY_12, '2026-01-04'),
      assign(nurses[1]!.id, DAY_12, '2026-01-04'),
    ];
    // Filling the first day shift leaves 27 of the 28 shifts short.
    expect(scoreAssignments(input, draft).unfilled).toHaveLength(27);
  });
});
