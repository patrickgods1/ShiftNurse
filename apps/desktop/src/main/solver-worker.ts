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
import { type SolveInput, type SolveOptions, type SolveProgress, solve } from '@shiftnurse/core';

export interface SolverWorkerData {
  input: SolveInput;
  options: Omit<SolveOptions, 'onProgress' | 'shouldCancel' | 'now'>;
  cancelFlag: SharedArrayBuffer;
}

export type SolverWorkerMessage =
  | { type: 'progress'; progress: SolveProgress }
  | { type: 'done'; report: ReturnType<typeof solve> }
  | { type: 'error'; message: string };

const port = parentPort;
if (!port) throw new Error('solver-worker must run as a worker thread');
const data = workerData as SolverWorkerData;
const flag = new Int32Array(data.cancelFlag);
const post = (message: SolverWorkerMessage) => port.postMessage(message);

try {
  const report = solve(data.input, {
    ...data.options,
    onProgress: (progress) => post({ type: 'progress', progress }),
    shouldCancel: () => Atomics.load(flag, 0) === 1,
  });
  post({ type: 'done', report });
} catch (err) {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
}
