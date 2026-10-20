/**
 * Whole-period CP-SAT when the runner says no schedule exists. The runner is replaced by a stub
 * that answers INFEASIBLE, so this runs without the native binary: what is under test is the
 * wrapper's decision to fall back to SA + LNS and the sentence it gives the manager.
 */

import { EncodingDisagreementError, isoDate, LocalSearch, type SolveInput } from '@shiftnurse/core';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
} from '@shiftnurse/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runnerBehaviour = vi.hoisted(() => ({
  start: (): Promise<unknown> => Promise.resolve('stub'),
  solve: (_model?: unknown, _params?: unknown): Promise<unknown> =>
    Promise.resolve({ status: 'INFEASIBLE', values: [], objective: 0, bound: 0, wallMs: 0 }),
}));

vi.mock('./cpsat-process.js', () => ({
  CpsatRunner: class {
    readonly pid = undefined;
    // No constructor: the real one's (command, args, readyTimeoutMs, onSpawn) are accepted and
    // ignored, since the stub spawns nothing.
    start() {
      return runnerBehaviour.start();
    }
    solve(model: unknown, params: unknown) {
      return runnerBehaviour.solve(model, params);
    }
    stop() {}
    dispose() {}
  },
}));

const { solveCpsat, solveHybrid } = await import('./ortools-solvers.js');

beforeEach(() => {
  resetFixtureCounters();
  runnerBehaviour.start = () => Promise.resolve('stub');
  runnerBehaviour.solve = () =>
    Promise.resolve({ status: 'INFEASIBLE', values: [], objective: 0, bound: 0, wallMs: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
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

  it('calls an INFEASIBLE answer a bug and lists the locked turnaround as context', async () => {
    const report = await solveCpsat(lockedTurnaround(), options);
    expect(report.stats.fellBackFrom?.reason).toBe(
      'CP-SAT reported the model INFEASIBLE, which is a bug in the CP-SAT encoding — please ' +
        'report it. Ran SA + LNS instead, which keeps the locked shifts as they are. Locked ' +
        'shifts already breaching a rule (context, not the cause): Dana Okafor Mon Jan 5 N12 (insufficient_rest); Dana Okafor Tue Jan 6 D12 (insufficient_rest)',
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
      'CP-SAT reported the model INFEASIBLE; ran SA + LNS instead. This is a bug in the ' +
        'CP-SAT encoding — please report it.',
    );
  });

  it('does not paper over a runner that fails for any other reason', async () => {
    runnerBehaviour.solve = () => Promise.reject(new Error('boom'));
    await expect(solveCpsat(lockedTurnaround(), options)).rejects.toThrow('boom');
  });
});

describe('a hybrid run whose CP-SAT windows go wrong', () => {
  const hybridOptions = { ...options, maxIterations: 800 };

  /** First window re-applies the model's own hint (legal, changes nothing); then the runner dies. */
  function diesAfterOneWindow() {
    let calls = 0;
    runnerBehaviour.solve = (model) => {
      calls++;
      if (calls > 1) return Promise.reject(new Error('runner crashed'));
      const hint = (model as { solution_hint?: { values: number[] } }).solution_hint;
      return Promise.resolve({
        status: 'OPTIMAL',
        values: hint?.values ?? [],
        objective: 0,
        bound: 0,
        wallMs: 0,
      });
    };
  }

  it('finishes a hybrid whose runner dies after a window as hybrid, and says when it stopped', async () => {
    diesAfterOneWindow();
    const report = await solveHybrid(lockedTurnaround(), hybridOptions);
    expect(report.stats.solver).toBe('hybrid');
    expect(report.stats.windows).toEqual({ tried: 1, improved: 0 });
    expect(report.stats.fellBackFrom).toEqual({
      solver: 'hybrid',
      reason:
        'CP-SAT windows stopped after 1 of 8: runner crashed; the rest of the run was SA + LNS',
    });
  });

  it('fails the Generate when CP-SAT and the rule engine disagree, instead of calling it a runner outage', async () => {
    diesAfterOneWindow();
    vi.spyOn(LocalSearch.prototype, 'applyWindow').mockImplementation(() => {
      throw new EncodingDisagreementError('dana', 'Dana Okafor', [], []);
    });
    await expect(solveHybrid(lockedTurnaround(), hybridOptions)).rejects.toBeInstanceOf(
      EncodingDisagreementError,
    );
  });

  it('still reports a plain fallback when the runner never starts', async () => {
    runnerBehaviour.start = () => Promise.reject(new Error('no binary'));
    const report = await solveHybrid(lockedTurnaround(), hybridOptions);
    expect(report.stats.solver).toBe('sa-lns');
    expect(report.stats.fellBackFrom?.solver).toBe('hybrid');
    expect(report.stats.fellBackFrom?.reason).toMatch(/^CP-SAT windows stopped: /);
  });
});
