/**
 * The shipped solver: greedy seed, then simulated annealing, then a full-engine report.
 *
 * The report is produced by the same `evaluateSchedule` / `scoreFairness` / `costSchedule`
 * the grid, the Fairness screen and the Cost strip use — never by the solver's own internal
 * tallies. If the two ever disagreed, the manager would see a Generate summary that the
 * schedule page then contradicted; deriving both from one engine makes that impossible.
 */

import { costSchedule } from '../cost/cost.js';
import type { Id, NurseRole } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import { deriveCounters } from '../fairness/ledger.js';
import { scoreFairness } from '../fairness/score.js';
import { evaluateSchedule } from '../rules/registry.js';
import type { Violation } from '../rules/types.js';
import { ScheduleView } from '../schedule/view.js';
import { anneal } from './anneal.js';
import { greedySeed } from './greedy.js';
import { SolverModel } from './model.js';
import { Rng } from './rng.js';
import type {
  SolveInput,
  SolveOptions,
  SolveProgress,
  SolveReport,
  Solver,
  UnfilledSlot,
} from './types.js';

export const localSearchSolver: Solver = {
  name: 'local-search',

  solve(input: SolveInput, options: SolveOptions): SolveReport {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const elapsed = () => now() - startedAt;
    const rng = new Rng(options.seed);
    const model = new SolverModel(input, options.weights);

    const report = (progress: Omit<SolveProgress, 'elapsedMs'>) =>
      options.onProgress?.({ ...progress, elapsedMs: elapsed() });

    report({
      fraction: 0,
      phase: 'seeding',
      iteration: 0,
      maxIterations: options.maxIterations,
      best: model.objective(),
      current: model.objective(),
      hardShortfall: model.hardShortfall(),
    });
    greedySeed(model);
    const seedObjective = model.objective();

    const shouldStop = (): 'cancelled' | 'timed_out' | null => {
      if (options.shouldCancel?.()) return 'cancelled';
      if (options.timeLimitMs !== undefined && elapsed() >= options.timeLimitMs) return 'timed_out';
      return null;
    };
    const result = anneal(model, rng, options, { onProgress: report, shouldStop });

    report({
      fraction: 1,
      phase: 'finishing',
      iteration: result.iterations,
      maxIterations: options.maxIterations,
      best: result.best,
      current: model.objective(),
      hardShortfall: model.hardShortfall(),
    });

    return buildReport(model, {
      seed: options.seed,
      iterations: result.iterations,
      accepted: result.accepted,
      improvements: result.improvements,
      elapsedMs: elapsed(),
      cancelled: result.cancelled,
      timedOut: result.timedOut,
      seedObjective,
    });
  },
};

/** The default entry point: {@link localSearchSolver}. */
export function solve(input: SolveInput, options: SolveOptions): SolveReport {
  return localSearchSolver.solve(input, options);
}

function buildReport(model: SolverModel, stats: SolveReport['stats']): SolveReport {
  const { input } = model;
  const assignments = model.assignments();
  const view = new ScheduleView({
    period: input.period,
    assignments,
    priorAssignments: input.priorAssignments,
    nurses: model.nurses,
    shiftTypes: model.shiftTypes,
  });
  const evaluation = evaluateSchedule(view, input.ruleSet, model.ctx);

  const activeNurses = model.candidates.map((i) => model.nurses[i]!);
  const fairness = scoreFairness({
    nurses: activeNurses,
    current: deriveCounters(view, {
      unit: input.unit,
      holidayDates: model.ctx.holidayDates,
      weekendDefinition: input.ruleSet.weekendDefinition,
      preferences: input.preferences,
      timeOff: input.timeOff,
    }),
    history: input.ledgerHistory,
    preferences: input.preferences,
    weights: input.ruleSet.fairnessWeights,
  });

  return {
    assignments,
    unfilled: unfilledFrom(evaluation.hardViolations),
    hardViolations: evaluation.hardViolations,
    softViolations: evaluation.softViolations,
    objective: model.breakdown(),
    fairness,
    ...(model.costCtx ? { cost: costSchedule(view, model.costCtx) } : {}),
    stats,
  };
}

/**
 * Staffing gaps, read off the coverage and ratio violations rather than counted separately,
 * so the Generate summary and the grid's red badges can never disagree about what is short.
 */
function unfilledFrom(violations: readonly Violation[]): UnfilledSlot[] {
  const out: UnfilledSlot[] = [];
  for (const v of violations) {
    if (v.code !== 'understaffed' && v.code !== 'ratio_breach') continue;
    const d = v.details ?? {};
    const date = v.dates[0];
    if (!date) continue;
    out.push({
      date: date as IsoDate,
      shiftTypeId: String(d.shiftTypeId ?? '') as Id,
      role: d.role as NurseRole,
      required: Number(d.required ?? 0),
      staffed: Number(d.staffed ?? 0),
      shortfall: Number(d.shortfall ?? 0),
      standard: v.code === 'ratio_breach' ? 'ratio' : 'coverage_floor',
    });
  }
  return out;
}
