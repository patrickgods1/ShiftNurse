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
 * The OR-Tools backends (M15: CP-SAT, hybrid) run here too, through `ortools-solvers.ts`: the
 * worker encodes, spawns its own runner process and decodes, so the main process never blocks on
 * a large encode. Their searches are async, so the same flag is polled on a timer and a 1 becomes
 * the runner's stop line.
 */

import { parentPort, workerData } from 'node:worker_threads';
import {
  PURE_SOLVERS,
  type SolveInput,
  type SolveOptions,
  type SolveProgress,
  type SolveReport,
  type SolverId,
} from '@shiftnurse/core';
import { solveCpsat, solveHybrid } from './ortools-solvers.js';

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

async function run(): Promise<SolveReport> {
  const pure = PURE_SOLVERS[data.solverId];
  if (pure) {
    return pure.solve(data.input, {
      ...data.options,
      onProgress: (progress) => post({ type: 'progress', progress }),
      shouldCancel: () => Atomics.load(flag, 0) === 1,
    });
  }
  if (!data.runnerPath) throw new Error('The OR-Tools runner is not installed');
  const options = {
    ...data.options,
    runnerPath: data.runnerPath,
    ...(data.deterministicTime !== undefined ? { deterministicTime: data.deterministicTime } : {}),
  };
  const hooks = {
    onProgress: (progress: SolveProgress) => post({ type: 'progress', progress }),
    shouldCancel: () => Atomics.load(flag, 0) === 1,
    onRunner: (pid: number) => post({ type: 'runner', pid }),
  };
  if (data.solverId === 'cp-sat') return solveCpsat(data.input, options, hooks);
  if (data.solverId === 'hybrid') return solveHybrid(data.input, options, hooks);
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
