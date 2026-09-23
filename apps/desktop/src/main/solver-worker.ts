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

export interface SolverWorkerData {
  input: SolveInput;
  /** Already resolved by the job, fallback included; the worker never re-decides. */
  solverId: SolverId;
  fellBackFrom?: { solver: SolverId; reason: string };
  options: Omit<SolveOptions, 'onProgress' | 'shouldCancel' | 'now'>;
  cancelFlag: SharedArrayBuffer;
}

export type SolverWorkerMessage =
  | { type: 'progress'; progress: SolveProgress }
  | { type: 'done'; report: SolveReport }
  | { type: 'error'; message: string };

const port = parentPort;
if (!port) throw new Error('solver-worker must run as a worker thread');
const data = workerData as SolverWorkerData;
const flag = new Int32Array(data.cancelFlag);
const post = (message: SolverWorkerMessage) => port.postMessage(message);

try {
  const solver = PURE_SOLVERS[data.solverId];
  if (!solver) throw new Error(`Solver "${data.solverId}" cannot run in the worker thread`);
  const report = solver.solve(data.input, {
    ...data.options,
    onProgress: (progress) => post({ type: 'progress', progress }),
    shouldCancel: () => Atomics.load(flag, 0) === 1,
  });
  if (data.fellBackFrom) report.stats.fellBackFrom = data.fellBackFrom;
  post({ type: 'done', report });
} catch (err) {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
}
