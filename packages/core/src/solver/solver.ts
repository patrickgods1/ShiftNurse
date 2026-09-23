/**
 * The shipped solver: greedy seed, then simulated annealing, then a full-engine report.
 *
 * The report is produced by the same `evaluateSchedule` / `scoreFairness` / `costSchedule`
 * the grid, the Fairness screen and the Cost strip use — never by the solver's own internal
 * tallies. If the two ever disagreed, the manager would see a Generate summary that the
 * schedule page then contradicted; deriving both from one engine makes that impossible.
 */

import { anneal } from './anneal.js';
import { greedySeed } from './greedy.js';
import { SolverModel } from './model.js';
import { buildReport } from './report.js';
import { Rng } from './rng.js';
import type { SolveInput, SolveOptions, SolveProgress, SolveReport, Solver } from './types.js';

export const localSearchSolver: Solver = {
  name: 'sa-lns',

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
      solver: 'sa-lns',
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
