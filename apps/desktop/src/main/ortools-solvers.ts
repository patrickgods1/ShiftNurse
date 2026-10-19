/**
 * The OR-Tools backends' orchestration: the async steps between core's pure halves and the
 * runner process. Used by the solver worker thread and by the solver benchmark, so both run the
 * same code.
 *
 * - CP-SAT: `prepareCpsat` → runner → `finishCpsat`.
 * - Hybrid: core's `LocalSearch` anneals in chunks; between chunks the worst few days go to
 *   CP-SAT and come back through the rule gate, kept only if the whole schedule improves.
 *
 * A hybrid whose runner fails part-way (crashed or missing) does not fail the Generate: it
 * finishes the remaining chunks as plain SA + LNS and reports `fellBackFrom: hybrid` with the
 * reason, which the dialog shows and the audit entry records. Only the runner's own calls are
 * caught: an answer the rule engine refuses (`EncodingDisagreementError`) is an encoding bug, not
 * an outage, and fails the run so it gets reported instead of hiding behind a fallback label.
 *
 * Whole-period CP-SAT that finds the model INFEASIBLE still gets the manager a schedule, but it
 * is not blamed on the pins. A correct encoding is satisfiable with every variable off, so
 * INFEASIBLE is a bug in the encoding; locked shifts that already break a rule are listed as
 * context only. SA + LNS measures every nurse against what their locks already break and
 * schedules around them, so `solveCpsat` runs it on the same input and seed and reports
 * `fellBackFrom: cp-sat`.
 */

import {
  CpsatInfeasibleError,
  describeDate,
  finishCpsat,
  LocalSearch,
  nurseName,
  PURE_SOLVERS,
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
  /**
   * Called with the runner's pid as soon as it is spawned (again after any respawn), so the
   * caller can kill it on teardown.
   */
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
  const runner = new CpsatRunner(options.runnerPath, [], undefined, hooks.onRunner);
  const watch = watchCancel(runner, hooks);
  let improvements = 0;
  let infeasible: CpsatInfeasibleError;
  try {
    await runner.start();
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
  } catch (err) {
    if (!(err instanceof CpsatInfeasibleError)) throw err;
    infeasible = err;
  } finally {
    watch.stop();
    runner.dispose();
  }
  return fallBackFromInfeasible(input, options, hooks, infeasible);
}

/** Most locked shifts a fallback reason names before it summarises the rest. */
const REASON_SHIFTS = 5;

/**
 * SA + LNS on the same input and seed, so a period whose locks CP-SAT cannot keep still gets
 * the same schedule every time it is generated.
 *
 * A second run on its own clock: it gets the full `timeLimitMs` again, on top of the time CP-SAT
 * already spent, because that time bought nothing and the manager still needs a schedule (the
 * dialog says a fallback ran). So `stats.elapsedMs` is the SA run's time alone, not the job's.
 */
function fallBackFromInfeasible(
  input: SolveInput,
  options: OrToolsOptions,
  hooks: OrToolsHooks,
  infeasible: CpsatInfeasibleError,
): SolveReport {
  const { runnerPath: _runnerPath, deterministicTime: _deterministicTime, ...rest } = options;
  const report = PURE_SOLVERS['sa-lns']!.solve(input, {
    ...rest,
    ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
    ...(hooks.shouldCancel ? { shouldCancel: hooks.shouldCancel } : {}),
  });
  report.stats.fellBackFrom = { solver: 'cp-sat', reason: infeasibleReason(input, infeasible) };
  return report;
}

/** "Dana Okafor Tue Jan 6 D12 (insufficient_rest)" per breaching locked shift, at most five. */
function infeasibleReason(input: SolveInput, infeasible: CpsatInfeasibleError): string {
  const locked = new Map(input.assignments.filter((a) => a.isLocked).map((a) => [a.id, a]));
  const codesByShift = new Map<string, Set<string>>();
  for (const v of infeasible.lockedBreaches) {
    for (const id of v.assignmentIds) {
      if (!locked.has(id)) continue;
      const codes = codesByShift.get(id) ?? new Set<string>();
      codes.add(v.code);
      codesByShift.set(id, codes);
    }
  }
  if (codesByShift.size === 0) {
    return (
      `CP-SAT reported the model ${infeasible.status}; ran SA + LNS instead. ` +
      'This is a bug in the CP-SAT encoding — please report it.'
    );
  }
  const named = [...codesByShift].map(([id, codes]) => {
    const a = locked.get(id)!;
    const nurse = input.nurses.find((n) => n.id === a.nurseId);
    const shiftType = input.shiftTypes.find((t) => t.id === a.shiftTypeId);
    // The model this came from was built from the same input and throws on an unknown id first.
    if (!nurse || !shiftType)
      throw new Error(`Locked assignment ${id} has an unknown nurse or shift`);
    return `${nurseName(nurse)} ${describeDate(a.date)} ${shiftType.abbreviation} (${[...codes].join(', ')})`;
  });
  const more = named.length - REASON_SHIFTS;
  return (
    `CP-SAT reported the model ${infeasible.status}, which is a bug in the CP-SAT encoding — ` +
    'please report it. Ran SA + LNS instead, which keeps the locked shifts as they are. ' +
    'Locked shifts already breaching a rule (context, not the cause): ' +
    named.slice(0, REASON_SHIFTS).join('; ') +
    (more > 0 ? `; … and ${more} more` : '')
  );
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

  const runner = new CpsatRunner(options.runnerPath, [], undefined, hooks.onRunner);
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
        // Only the runner's own calls are an "outage"; the core calls between them are not, so an
        // EncodingDisagreementError from applyWindow propagates and fails the run.
        let started = false;
        try {
          await runner.start();
          started = true;
        } catch (err) {
          runnerFailure = err instanceof Error ? err.message : String(err);
        }
        if (started) {
          const job = search.encodeWindow(
            search.pickWindow(HYBRID_WINDOW_DAYS),
            HYBRID_WINDOW_TIME,
          );
          let result: Awaited<ReturnType<CpsatRunner['solve']>> | undefined;
          try {
            result = await runner.solve(job.model, job.params);
          } catch (err) {
            runnerFailure = err instanceof Error ? err.message : String(err);
          }
          if (result) {
            windows.tried++;
            if (result.values.length > 0 && search.applyWindow(job, result.values).improved) {
              windows.improved++;
            }
          }
        }
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
    ...(runnerFailure === undefined
      ? { solver: 'hybrid' as const }
      : windows.tried === 0
        ? {
            solver: 'sa-lns' as const,
            fellBackFrom: {
              solver: 'hybrid' as const,
              reason: `CP-SAT windows stopped: ${runnerFailure}`,
            },
          }
        : {
            // Windows were applied, so the schedule is part hybrid: say when it stopped.
            solver: 'hybrid' as const,
            fellBackFrom: {
              solver: 'hybrid' as const,
              reason:
                `CP-SAT windows stopped after ${windows.tried} of ${HYBRID_ROUNDS}: ` +
                `${runnerFailure}; the rest of the run was SA + LNS`,
            },
          }),
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
