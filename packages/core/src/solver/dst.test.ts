import { beforeEach, describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import { defaultRuleSet } from '../rules/registry.js';
import type { RuleSet } from '../rules/types.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  UNIT_ID,
} from '../testing/fixtures.js';
import { decisionsFor, encodeCpsat } from './cpsat/encode.js';
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

describe('generating over the fall-back night', () => {
  // 02:00 on Sun 2026-11-01 (day 20758 × 1440 + 120) goes back to 01:00: the night of Sat 31 Oct
  // is 13 hours on the floor.
  const FALL_BACK = { atMinute: 29_891_640, deltaMinutes: -60 };

  /** `max-hours-in-24` on and hard at 12. */
  const twelveIn24: RuleSet = (() => {
    const base = defaultRuleSet(UNIT_ID);
    return {
      ...base,
      configs: base.configs.map((c) =>
        c.ruleId === 'max-hours-in-24'
          ? { ...c, enabled: true, severityOverride: 'hard' as const, params: { maxHours: 12 } }
          : c,
      ),
    };
  })();

  /** One nurse over a fortnight whose only demand is a Saturday night: 31 Oct and 7 Nov. */
  const input = (dst: boolean) =>
    solveInputFrom({
      nurses: [makeNurse({ id: 'ada', isChargeEligible: true })],
      shiftTypes: [NIGHT_12],
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      coverageRequirements: coverageAllWeek(NIGHT_12, 'RN', 1).filter((c) => c.weekday === 6),
      ruleSet: twelveIn24,
      ...(dst ? { dstTransitions: [FALL_BACK] } : {}),
    });

  it('never generates a fall-back night past a twelve-hour limit when the rule is hard', () => {
    // 780 real minutes against 720: the night cannot be worked, so it is reported short.
    const report = solve(input(true), { seed: 1, maxIterations: 200 });
    // 7 Nov is an ordinary 12-hour night.
    expect(report.assignments.map((a) => [a.nurseId, a.date])).toEqual([['ada', '2026-11-07']]);
    // The one hard finding is the empty night itself, never the cap.
    expect(report.hardViolations.map((v) => v.ruleId)).toEqual(['coverage-minimums']);
    expect(report.unfilled.map((u) => [u.date, u.shiftTypeId, u.shortfall])).toEqual([
      ['2026-10-31', NIGHT_12.id, 1],
    ]);
    // CP-SAT's model forbids the same night: its coefficient is 780 against 720.
    const cpsatJudges = (dst: boolean) => {
      const encoding = encodeCpsat(input(dst));
      const night = [assign('ada', NIGHT_12, '2026-10-31')];
      return encoding.builder.evaluate(decisionsFor(encoding, night), encoding.objectiveScale)
        .violated;
    };
    expect(cpsatJudges(true).join('\n')).toMatch(/hours in 24/);
    expect(cpsatJudges(false)).toEqual([]);

    // On the wall clock it is 720, at the cap, and both nights are filled.
    const wall = solve(input(false), { seed: 1, maxIterations: 200 });
    expect(wall.assignments.map((a) => [a.nurseId, a.date]).sort()).toEqual([
      ['ada', '2026-10-31'],
      ['ada', '2026-11-07'],
    ]);
    expect(wall.unfilled).toEqual([]);
  });
});
