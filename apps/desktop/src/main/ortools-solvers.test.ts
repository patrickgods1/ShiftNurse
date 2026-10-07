/**
 * Whole-period CP-SAT when the runner says no schedule exists. The runner is replaced by a stub
 * that answers INFEASIBLE, so this runs without the native binary: what is under test is the
 * wrapper's decision to fall back to SA + LNS and the sentence it gives the manager.
 */

import { isoDate, type SolveInput } from '@shiftnurse/core';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
} from '@shiftnurse/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runnerBehaviour = vi.hoisted(() => ({
  solve: (): Promise<unknown> =>
    Promise.resolve({ status: 'INFEASIBLE', values: [], objective: 0, bound: 0, wallMs: 0 }),
}));

vi.mock('./cpsat-process.js', () => ({
  CpsatRunner: class {
    readonly pid = undefined;
    start() {
      return Promise.resolve('stub');
    }
    solve() {
      return runnerBehaviour.solve();
    }
    stop() {}
    dispose() {}
  },
}));

const { solveCpsat } = await import('./ortools-solvers.js');

beforeEach(() => {
  resetFixtureCounters();
  runnerBehaviour.solve = () =>
    Promise.resolve({ status: 'INFEASIBLE', values: [], objective: 0, bound: 0, wallMs: 0 });
});

/** Dana's Monday night (19:00–07:00) and Tuesday day (07:00) are both locked: no rest at all. */
function lockedTurnaround(): SolveInput {
  const nurses = [
    makeNurse({ id: 'dana', firstName: 'Dana', lastName: 'Okafor', isChargeEligible: true }),
    makeNurse({ isChargeEligible: true }),
    makeNurse({ isChargeEligible: true }),
    makeNurse({ isChargeEligible: true }),
  ];
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 1),
      ...coverageAllWeek(NIGHT_12, 'RN', 1),
    ],
    assignments: [
      assign('dana', NIGHT_12, '2026-01-05', { id: 'mon-night', isLocked: true }),
      assign('dana', DAY_12, '2026-01-06', { id: 'tue-day', isLocked: true }),
    ],
  });
}

const options = { runnerPath: '/no/runner', seed: 7, maxIterations: 2_000 };

describe('CP-SAT that cannot keep the locked shifts', () => {
  it('still hands the manager a schedule, built by SA + LNS around the pins', async () => {
    const report = await solveCpsat(lockedTurnaround(), options);
    expect(report.stats.solver).toBe('sa-lns');
    expect(report.stats.fellBackFrom?.solver).toBe('cp-sat');
    const ids = report.assignments.map((a) => a.id);
    expect(ids).toContain('mon-night');
    expect(ids).toContain('tue-day');
  });

  it('names both locked shifts of the turnaround and the rule they break', async () => {
    const report = await solveCpsat(lockedTurnaround(), options);
    expect(report.stats.fellBackFrom?.reason).toBe(
      'CP-SAT found no schedule that keeps every hard rule around the locked shifts; ran SA + ' +
        'LNS, which keeps them as they are. Locked shifts already breaching a rule: ' +
        'Dana Okafor Mon Jan 5 N12 (insufficient_rest); Dana Okafor Tue Jan 6 D12 (insufficient_rest)',
    );
  });

  it('gives the same schedule every time for the same seed', async () => {
    const first = await solveCpsat(lockedTurnaround(), options);
    resetFixtureCounters();
    const second = await solveCpsat(lockedTurnaround(), options);
    const key = (r: typeof first) =>
      r.assignments.map((a) => `${a.nurseId}|${a.date}|${a.shiftTypeId}`);
    expect(key(second)).toEqual(key(first));
  });

  it('asks for a bug report when no locked shift explains the refusal', async () => {
    const input = { ...lockedTurnaround(), assignments: [] };
    const report = await solveCpsat(input, options);
    expect(report.stats.solver).toBe('sa-lns');
    expect(report.stats.fellBackFrom?.reason).toBe(
      'CP-SAT reported the model INFEASIBLE; ran SA + LNS instead. This is likely a bug in the ' +
        'CP-SAT encoding — please report it.',
    );
  });

  it('does not paper over a runner that fails for any other reason', async () => {
    runnerBehaviour.solve = () => Promise.reject(new Error('boom'));
    await expect(solveCpsat(lockedTurnaround(), options)).rejects.toThrow('boom');
  });
});
