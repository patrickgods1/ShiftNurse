/**
 * The CP-SAT backend end to end against the real runner: core encodes, the runner searches, core
 * decodes through the rule gate. Skipped when the runner has not been fetched
 * (`npm run fetch:cpsat -w @shiftnurse/desktop`).
 *
 * Beyond "it produces a legal schedule", this checks the one thing the pure encoder tests cannot:
 * that CP-SAT cannot game the encoding. Its reported objective is recomputed by the builder's
 * evaluator from the decisions alone; if any auxiliary were only loosely constrained, CP-SAT
 * would set it below its definition and report a better objective than the schedule deserves.
 */

import { fileURLToPath } from 'node:url';
import {
  ALL_RULES,
  decisionsFor,
  finishCpsat,
  isoDate,
  prepareCpsat,
  type SolveInput,
  solve,
} from '@shiftnurse/core';
import {
  coverageAllWeek,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  timeOff,
} from '@shiftnurse/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CpsatRunner, resolveRunnerPath } from './cpsat-process.js';
import { solveHybrid } from './ortools-solvers.js';

const RUNNER = resolveRunnerPath({
  packaged: false,
  resourcesPath: '',
  appPath: fileURLToPath(new URL('../..', import.meta.url)),
});
const runners: CpsatRunner[] = [];

beforeEach(() => resetFixtureCounters());
afterEach(() => {
  for (const r of runners.splice(0)) r.dispose();
});

function unitInput(): SolveInput {
  const nurses = Array.from({ length: 8 }, (_, i) =>
    makeNurse({ isChargeEligible: i % 2 === 0, isNovice: i === 7 }),
  );
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12, EVENING_8],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 2, 2),
      ...coverageAllWeek(NIGHT_12, 'RN', 1, 2),
      ...coverageAllWeek(EVENING_8, 'RN', 0, 1),
    ],
    timeOff: [timeOff(nurses[0]!.id, '2026-01-08', '2026-01-10')],
  });
}

async function solveOnce(input: SolveInput, seed: number) {
  const job = prepareCpsat(input, { seed, deterministicTime: 5 });
  const runner = new CpsatRunner(RUNNER!);
  runners.push(runner);
  const result = await runner.solve(job.model, job.params);
  const report = finishCpsat(input, job, result, {
    seed,
    elapsedMs: result.wallMs,
    improvements: 0,
    cancelled: false,
    timedOut: false,
  });
  return { job, result, report };
}

const NURSE_SCOPE = new Set(ALL_RULES.filter((r) => r.scope === 'nurse').map((r) => r.id));

describe.skipIf(RUNNER === undefined)('CP-SAT against the real runner', () => {
  it('produces a schedule no nurse-level rule objects to', async () => {
    const { report } = await solveOnce(unitInput(), 11);
    const nurseLevel = report.hardViolations.filter(
      (v) => NURSE_SCOPE.has(v.ruleId) && v.code !== 'under_contracted_hours',
    );
    expect(nurseLevel.map((v) => v.message)).toEqual([]);
    expect(report.stats.solver).toBe('cp-sat');
  }, 60_000);

  it('cannot price its own answer better than the schedule deserves', async () => {
    const input = unitInput();
    const { job, result, report } = await solveOnce(input, 11);
    const evaluation = job.encoding.builder.evaluate(
      decisionsFor(job.encoding, report.assignments),
      job.encoding.objectiveScale,
    );
    expect(evaluation.violated).toEqual([]);
    // CP-SAT may leave slack in a lower-bounded cost it has not finished minimising, which only
    // makes its own figure higher. Lower would mean it satisfied the encoding with a cost below
    // what the schedule actually incurs — an encoding it could game.
    expect(result.objective).toBeGreaterThanOrEqual(evaluation.objective - 1e-6);
    expect(result.objective - evaluation.objective).toBeLessThan(1);
    // And the annealer's model agrees with both, to fair-share rounding.
    expect(report.objective.total).toBeCloseTo(result.objective, 0);
  }, 60_000);

  it('does no worse than the greedy schedule it started from', async () => {
    const { job, report } = await solveOnce(unitInput(), 11);
    expect(report.objective.total).toBeLessThanOrEqual(job.seedObjective + 1e-6);
  }, 60_000);

  it('regenerates the identical schedule from the same inputs', async () => {
    const key = (r: { assignments: { nurseId: string; date: string; shiftTypeId: string }[] }) =>
      r.assignments.map((a) => `${a.nurseId}|${a.date}|${a.shiftTypeId}`).sort();
    const first = await solveOnce(unitInput(), 11);
    resetFixtureCounters();
    const second = await solveOnce(unitInput(), 11);
    expect(key(second.report)).toEqual(key(first.report));
  }, 60_000);
});

describe.skipIf(RUNNER === undefined)('the hybrid against the real runner', () => {
  const OPTIONS = { seed: 5, maxIterations: 40_000, runnerPath: RUNNER ?? '' };

  it('hands windows to CP-SAT and keeps every nurse legal', async () => {
    const report = await solveHybrid(unitInput(), OPTIONS);
    expect(report.stats.solver).toBe('hybrid');
    expect(report.stats.windows?.tried).toBeGreaterThan(0);
    const nurseLevel = report.hardViolations.filter(
      (v) => NURSE_SCOPE.has(v.ruleId) && v.code !== 'under_contracted_hours',
    );
    expect(nurseLevel.map((v) => v.message)).toEqual([]);
    const sa = solve(unitInput(), OPTIONS);
    console.log('HYBRID', report.objective.total, report.stats.windows, 'SA', sa.objective.total);
  }, 120_000);

  it('regenerates the identical schedule from the same inputs', async () => {
    const key = (r: { assignments: { nurseId: string; date: string; shiftTypeId: string }[] }) =>
      r.assignments.map((a) => `${a.nurseId}|${a.date}|${a.shiftTypeId}`).sort();
    const first = await solveHybrid(unitInput(), OPTIONS);
    resetFixtureCounters();
    const second = await solveHybrid(unitInput(), OPTIONS);
    expect(key(second)).toEqual(key(first));
  }, 120_000);

  it('finishes as SA + LNS, and says so, when the runner cannot start', async () => {
    const report = await solveHybrid(unitInput(), {
      ...OPTIONS,
      runnerPath: '/nonexistent/cpsat-runner',
    });
    expect(report.stats.solver).toBe('sa-lns');
    expect(report.stats.fellBackFrom?.solver).toBe('hybrid');
    expect(report.assignments.length).toBeGreaterThan(0);
  }, 120_000);
});
