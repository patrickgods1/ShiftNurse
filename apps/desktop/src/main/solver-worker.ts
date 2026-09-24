/**
 * The solver's worker-thread entry point.
 *
 * A six-week solve for a real unit runs for seconds. On the main thread that would freeze
 * every IPC handler — the grid could not even repaint — so the solve runs here, on a copy of
 * the input, and only plain data crosses back: progress messages as it goes, the report at
 * the end. The main process owns the database; this thread never touches it.
 *
 * Cancellation cannot arrive as a message: a synchronous solve never yields to the event loop
 * to receive one. So the main thread hands over a `SharedArrayBuffer` and the solver polls
 * one integer in it between iterations. Setting it to 1 is the whole cancel protocol.
 *
 * CP-SAT (M15) runs here too: the worker encodes the model, spawns its own runner process, and
 * decodes the answer, so the main process never blocks on a large encode. Its search is async,
 * so the worker polls the same flag on a timer and turns a 1 into the runner's stop line.
 */

import { parentPort, workerData } from 'node:worker_threads';
import {
  finishCpsat,
  PURE_SOLVERS,
  prepareCpsat,
  type SolveInput,
  type SolveOptions,
  type SolveProgress,
  type SolveReport,
  type SolverId,
} from '@shiftnurse/core';
import { CpsatRunner } from './cpsat-process.js';

export interface SolverWorkerData {
  input: SolveInput;
  /** Already resolved by the job, fallback included; the worker never re-decides. */
  solverId: SolverId;
  fellBackFrom?: { solver: SolverId; reason: string };
  options: Omit<SolveOptions, 'onProgress' | 'shouldCancel' | 'now'>;
  cancelFlag: SharedArrayBuffer;
  /** The CP-SAT runner, for the OR-Tools backends. */
  runnerPath?: string;
  /** CP-SAT's deterministic time budget; its default when absent. */
  deterministicTime?: number;
}

export type SolverWorkerMessage =
  | { type: 'progress'; progress: SolveProgress }
  | { type: 'done'; report: SolveReport }
  | { type: 'error'; message: string }
  /** The CP-SAT runner's process id, so the main process can kill it if the job is torn down. */
  | { type: 'runner'; pid: number };

const port = parentPort;
if (!port) throw new Error('solver-worker must run as a worker thread');
const data = workerData as SolverWorkerData;
const flag = new Int32Array(data.cancelFlag);
const post = (message: SolverWorkerMessage) => port.postMessage(message);

const CANCEL_POLL_MS = 100;

/** CP-SAT: encode here, search in the runner process, decode and report here. */
async function solveWithCpsat(): Promise<SolveReport> {
  if (!data.runnerPath) throw new Error('The OR-Tools runner is not installed');
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const { seed, timeLimitMs } = data.options;
  post({
    type: 'progress',
    progress: {
      fraction: 0,
      phase: 'seeding',
      iteration: 0,
      maxIterations: 0,
      best: 0,
      current: 0,
      elapsedMs: 0,
    },
  });
  const job = prepareCpsat(data.input, {
    seed,
    ...(data.deterministicTime !== undefined ? { deterministicTime: data.deterministicTime } : {}),
    ...(timeLimitMs !== undefined ? { timeLimitMs } : {}),
  });
  const budgetMs = (job.params.max_deterministic_time ?? 60) * 1000;

  const runner = new CpsatRunner(data.runnerPath);
  let cancelled = false;
  let improvements = 0;
  const poll = setInterval(() => {
    if (!cancelled && Atomics.load(flag, 0) === 1) {
      cancelled = true;
      runner.stop();
    }
  }, CANCEL_POLL_MS);
  try {
    await runner.start();
    if (runner.pid !== undefined) post({ type: 'runner', pid: runner.pid });
    const result = await runner.solve(job.model, job.params, (p) => {
      improvements++;
      post({
        type: 'progress',
        progress: {
          // Deterministic time only roughly tracks the wall clock; this is a hint, not a promise.
          fraction: Math.min(0.99, p.wallMs / budgetMs),
          phase: 'searching',
          iteration: 0,
          maxIterations: 0,
          best: p.objective,
          current: p.objective,
          bound: p.bound,
          elapsedMs: elapsed(),
        },
      });
    });
    return finishCpsat(data.input, job, result, {
      seed,
      elapsedMs: elapsed(),
      improvements,
      cancelled,
      timedOut: timeLimitMs !== undefined && elapsed() >= timeLimitMs,
    });
  } finally {
    clearInterval(poll);
    runner.dispose();
  }
}

async function run(): Promise<SolveReport> {
  const pure = PURE_SOLVERS[data.solverId];
  if (pure) {
    return pure.solve(data.input, {
      ...data.options,
      onProgress: (progress) => post({ type: 'progress', progress }),
      shouldCancel: () => Atomics.load(flag, 0) === 1,
    });
  }
  if (data.solverId === 'cp-sat') return solveWithCpsat();
  throw new Error(`Solver "${data.solverId}" cannot run in the worker thread`);
}

run().then(
  (report) => {
    if (data.fellBackFrom) report.stats.fellBackFrom = data.fellBackFrom;
    post({ type: 'done', report });
  },
  (err: unknown) =>
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
);
