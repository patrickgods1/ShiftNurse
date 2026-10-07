/**
 * What CP-SAT's "no schedule exists" means here. A correctly encoded model is always satisfiable
 * with every decision variable off, so INFEASIBLE can only come from the constants: locked shifts
 * that already break a hard rule. `finishCpsat` must say which, so the desktop can fall back to
 * SA + LNS and tell the manager why.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../../domain/entities.js';
import { isoDate } from '../../domain/time.js';
import { defaultRuleSet } from '../../rules/registry.js';
import type { RuleSet } from '../../rules/types.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  UNIT_ID,
} from '../../testing/fixtures.js';
import type { SolveInput } from '../types.js';
import { CpsatInfeasibleError, finishCpsat, lockedHardViolations, prepareCpsat } from './index.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** Ten hours' rest, hard: the night ending 07:00 Tuesday leaves none before a 07:00 day. */
function restTenHours(): RuleSet {
  const base = defaultRuleSet(UNIT_ID);
  return {
    ...base,
    configs: base.configs.map((c) =>
      c.ruleId === 'min-rest-between-shifts'
        ? { ...c, severityOverride: 'hard', params: { ...c.params, minRestHours: 10 } }
        : c,
    ),
  };
}

function unit(nurses: Nurse[], assignments: Assignment[]): SolveInput {
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 1),
      ...coverageAllWeek(NIGHT_12, 'RN', 1),
    ],
    assignments,
    ruleSet: restTenHours(),
  });
}

const dana = () => makeNurse({ id: 'dana', firstName: 'Dana', lastName: 'Okafor' });

describe('locked shifts that already break a hard rule', () => {
  it('flags a locked Monday night followed by a locked Tuesday day', () => {
    // Mon 5 Jan 19:00 – Tue 6 Jan 07:00, then Tue 6 Jan 07:00: zero hours off, 10 required.
    const night = assign('dana', NIGHT_12, '2026-01-05', { id: 'mon-night', isLocked: true });
    const day = assign('dana', DAY_12, '2026-01-06', { id: 'tue-day', isLocked: true });
    const breaches = lockedHardViolations(unit([dana()], [night, day]));
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.code).toBe('insufficient_rest');
    expect(breaches[0]!.assignmentIds).toContain('tue-day');
    expect(breaches[0]!.assignmentIds).toContain('mon-night');
  });

  it('finds nothing to blame when the Tuesday day is only a draft, not a lock', () => {
    const night = assign('dana', NIGHT_12, '2026-01-05', { id: 'mon-night', isLocked: true });
    const day = assign('dana', DAY_12, '2026-01-06', { id: 'tue-day' });
    expect(lockedHardViolations(unit([dana()], [night, day]))).toEqual([]);
  });

  it('never blames a locked shift for leaving a nurse under her contracted hours', () => {
    // One locked shift in two weeks is far under contract, a floor the gate ignores.
    const lone = assign('dana', DAY_12, '2026-01-07', { id: 'wed-day', isLocked: true });
    expect(lockedHardViolations(unit([dana()], [lone]))).toEqual([]);
  });
});

describe('finishing an infeasible CP-SAT run', () => {
  const run = { seed: 1, elapsedMs: 0, improvements: 0, cancelled: false, timedOut: false };

  for (const status of ['INFEASIBLE', 'MODEL_INVALID'] as const) {
    it(`names the locked turnaround when CP-SAT reports ${status}`, () => {
      const night = assign('dana', NIGHT_12, '2026-01-05', { id: 'mon-night', isLocked: true });
      const day = assign('dana', DAY_12, '2026-01-06', { id: 'tue-day', isLocked: true });
      const input = unit([dana()], [night, day]);
      const job = prepareCpsat(input, { seed: 1 });
      let thrown: unknown;
      try {
        finishCpsat(input, job, { status, values: [], objective: 0, bound: 0 }, run);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CpsatInfeasibleError);
      const error = thrown as CpsatInfeasibleError;
      expect(error.status).toBe(status);
      expect(error.lockedBreaches.map((v) => v.code)).toEqual(['insufficient_rest']);
      expect(error.lockedBreaches[0]!.assignmentIds).toContain('tue-day');
    });
  }

  it('blames no shift when nothing is locked, so the encoding is at fault', () => {
    const input = unit([dana()], []);
    const job = prepareCpsat(input, { seed: 1 });
    let thrown: unknown;
    try {
      finishCpsat(input, job, { status: 'INFEASIBLE', values: [], objective: 0, bound: 0 }, run);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CpsatInfeasibleError);
    expect((thrown as CpsatInfeasibleError).lockedBreaches).toEqual([]);
  });
});
