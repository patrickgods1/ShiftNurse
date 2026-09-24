/**
 * The OR-Tools backends' orchestration: the async steps between core's pure halves and the
 * runner process. Used by the solver worker thread and by the solver benchmark, so both run the
 * same code.
 *
 * - CP-SAT: `prepareCpsat` → runner → `finishCpsat`.
 * - Hybrid: core's `LocalSearch` anneals in chunks; between chunks the worst few days go to
 *   CP-SAT and come back through the rule gate, kept only if the whole schedule improves.
 *
 * A hybrid whose runner fails part-way (crashed, missing, or an answer the rule engine refuses)
 * does not fail the Generate: it finishes the remaining chunks as plain SA + LNS and reports
 * `fellBackFrom: hybrid` with the reason, which the dialog shows and the audit entry records.
 */

import {
  finishCpsat,
  LocalSearch,
  prepareCpsat,
  type SolveInput,
  type SolveOptions,
  type SolveProgress,
  type SolveReport,
} from '@shiftnurse/core';
import { CpsatRunner } from './cpsat-process.js';

export interface OrToolsOptions extends Omit<SolveOptions, 'onProgress' | 'shouldCancel' | 'now'> {
  runnerPath: string;
  /** CP-SAT only: the whole-period search budget, in deterministic time. */
  deterministicTime?: number;
}

export interface OrToolsHooks {
  onProgress?: (progress: SolveProgress) => void;
  shouldCancel?: () => boolean;
  /** Called with the runner's pid once it is up, so the caller can kill it on teardown. */
  onRunner?: (pid: number) => void;
}

/** Annealing chunks, and so CP-SAT windows, per hybrid run. */
export const HYBRID_ROUNDS = 8;
/** Consecutive days per window: enough to untangle a rest-rule knot across a weekend. */
export const HYBRID_WINDOW_DAYS = 3;
/** Deterministic-time budget per window; a 3-day window is usually solved well inside it. */
export const HYBRID_WINDOW_TIME = 2;
const CANCEL_POLL_MS = 100;

/** Poll `shouldCancel` while an async step runs, turning a cancel into the runner's stop line. */
function watchCancel(
  runner: CpsatRunner,
  hooks: OrToolsHooks,
): { stop: () => void; cancelled: () => boolean } {
  let cancelled = false;
  const timer = setInterval(() => {
    if (!cancelled && hooks.shouldCancel?.()) {
      cancelled = true;
      runner.stop();
    }
  }, CANCEL_POLL_MS);
  return { stop: () => clearInterval(timer), cancelled: () => cancelled };
}

export async function solveCpsat(
  input: SolveInput,
  options: OrToolsOptions,
  hooks: OrToolsHooks = {},
): Promise<SolveReport> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  hooks.onProgress?.({
    fraction: 0,
    phase: 'seeding',
    iteration: 0,
    maxIterations: 0,
    best: 0,
    current: 0,
    elapsedMs: 0,
  });
  const job = prepareCpsat(input, {
    seed: options.seed,
    ...(options.deterministicTime !== undefined
      ? { deterministicTime: options.deterministicTime }
      : {}),
    ...(options.timeLimitMs !== undefined ? { timeLimitMs: options.timeLimitMs } : {}),
    ...(options.weights ? { weights: options.weights } : {}),
  });
  const budgetMs = (job.params.max_deterministic_time ?? 60) * 1000;
  const runner = new CpsatRunner(options.runnerPath);
  const watch = watchCancel(runner, hooks);
  let improvements = 0;
  try {
    await runner.start();
    if (runner.pid !== undefined) hooks.onRunner?.(runner.pid);
    const result = await runner.solve(job.model, job.params, (p) => {
      improvements++;
      hooks.onProgress?.({
        // Deterministic time only roughly tracks the wall clock: a hint, not a promise.
        fraction: Math.min(0.99, p.wallMs / budgetMs),
        phase: 'searching',
        iteration: 0,
        maxIterations: 0,
        best: p.objective,
        current: p.objective,
        bound: p.bound,
        elapsedMs: elapsed(),
      });
    });
    return finishCpsat(input, job, result, {
      seed: options.seed,
      elapsedMs: elapsed(),
      improvements,
      cancelled: watch.cancelled(),
      timedOut: options.timeLimitMs !== undefined && elapsed() >= options.timeLimitMs,
    });
  } finally {
    watch.stop();
    runner.dispose();
  }
}

export async function solveHybrid(
  input: SolveInput,
  options: OrToolsOptions,
  hooks: OrToolsHooks = {},
): Promise<SolveReport> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const report = (p: Omit<SolveProgress, 'elapsedMs'>) =>
    hooks.onProgress?.({ ...p, elapsedMs: elapsed() });
  const search = new LocalSearch(input, options);
  const max = Math.max(0, Math.floor(options.maxIterations));

  report({
    fraction: 0,
    phase: 'seeding',
    iteration: 0,
    maxIterations: max,
    best: search.model.objective(),
    current: search.model.objective(),
    hardShortfall: search.model.hardShortfall(),
  });
  search.seed();

  let cancelled = false;
  let timedOut = false;
  const shouldStop = (): 'cancelled' | 'timed_out' | null => {
    if (hooks.shouldCancel?.()) return 'cancelled';
    if (options.timeLimitMs !== undefined && elapsed() >= options.timeLimitMs) return 'timed_out';
    return null;
  };

  const runner = new CpsatRunner(options.runnerPath);
  let runnerFailure: string | undefined;
  let iterations = 0;
  let accepted = 0;
  let improvements = 0;
  const windows = { tried: 0, improved: 0 };

  try {
    for (let round = 0; round < HYBRID_ROUNDS; round++) {
      const from = Math.floor((round * max) / HYBRID_ROUNDS);
      const to = Math.floor(((round + 1) * max) / HYBRID_ROUNDS);
      const chunk = search.anneal(from, to, { onProgress: report, shouldStop });
      iterations += chunk.iterations;
      accepted += chunk.accepted;
      improvements += chunk.improvements;
      if (chunk.cancelled || chunk.timedOut) {
        cancelled = chunk.cancelled;
        timedOut = chunk.timedOut;
        break;
      }
      if (runnerFailure !== undefined) continue;

      const watch = watchCancel(runner, hooks);
      try {
        await runner.start();
        if (windows.tried === 0 && runner.pid !== undefined) hooks.onRunner?.(runner.pid);
        const job = search.encodeWindow(search.pickWindow(HYBRID_WINDOW_DAYS), HYBRID_WINDOW_TIME);
        const result = await runner.solve(job.model, job.params);
        windows.tried++;
        if (result.values.length > 0 && search.applyWindow(job, result.values).improved) {
          windows.improved++;
        }
      } catch (err) {
        runnerFailure = err instanceof Error ? err.message : String(err);
      } finally {
        watch.stop();
      }
      if (watch.cancelled()) {
        cancelled = true;
        break;
      }
      report({
        fraction: to / Math.max(1, max),
        phase: 'annealing',
        iteration: to,
        maxIterations: max,
        best: search.model.objective(),
        current: search.model.objective(),
        hardShortfall: search.model.hardShortfall(),
      });
    }
  } finally {
    runner.dispose();
  }

  report({
    fraction: 1,
    phase: 'finishing',
    iteration: iterations,
    maxIterations: max,
    best: search.model.objective(),
    current: search.model.objective(),
    hardShortfall: search.model.hardShortfall(),
  });
  return search.report({
    ...(runnerFailure !== undefined
      ? {
          solver: 'sa-lns' as const,
          fellBackFrom: {
            solver: 'hybrid' as const,
            reason: `CP-SAT windows stopped: ${runnerFailure}`,
          },
        }
      : { solver: 'hybrid' as const }),
    windows,
    seed: options.seed,
    iterations,
    accepted,
    improvements,
    elapsedMs: elapsed(),
    cancelled,
    timedOut,
    seedObjective: search.seedObjective,
  });
}
