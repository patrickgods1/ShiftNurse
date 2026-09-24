/**
 * The main process's handle on the CP-SAT runner (native/cpsat-runner): spawn it, send it models,
 * stream its progress, stop it, and shut it down with the app.
 *
 * ## Why here and not in core or the worker thread
 *
 * `packages/core` may not start processes — it builds the model (`encode`) and reads the answer
 * (`decode`) as plain data. The solver worker thread runs a *synchronous* solve that cannot await
 * a subprocess. So the OR-Tools backends run in main: encode, `await runner.solve(...)`, decode.
 * Main is never blocked while CP-SAT searches; the search runs in another process entirely.
 *
 * ## Protocol
 *
 * JSON lines, schema in native/cpsat-runner/runner.proto. Requests are serialised here — the
 * runner answers a second concurrent request with an error rather than queueing it — so every
 * `solve` call waits its turn behind the previous one. A runner that exits with a request pending
 * rejects that request with its exit code and the tail of stderr, so a crash reads as an error in
 * the Generate dialog rather than a solve that never finishes.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** `CpSolverStatus` names, as the runner prints them. */
export type CpsatStatus = 'UNKNOWN' | 'MODEL_INVALID' | 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';

export interface CpsatProgress {
  objective: number;
  bound: number;
  wallMs: number;
}

export interface CpsatResult extends CpsatProgress {
  status: CpsatStatus;
  /** One value per model variable, in variable order; empty when no solution was found. */
  values: number[];
}

/** The runner's raw event line (runner.proto `Event`, proto field names, int64 as strings). */
interface RunnerEvent {
  type: 'ready' | 'progress' | 'result' | 'error';
  id: string;
  version: string;
  objective: number;
  bound: number;
  wall_ms: string;
  status: CpsatStatus;
  values: string[];
  message: string;
}

/**
 * Generous on purpose: a native binary's *first* launch can be slow — Rosetta translating an x64
 * runner and its libraries on Apple silicon, antivirus scanning twenty DLLs on Windows. A
 * timeout here makes the hybrid finish without CP-SAT, which is a different (if reported)
 * schedule from the same inputs.
 */
const READY_TIMEOUT_MS = 120_000;
/** After a stop and EOF, how long a runner gets to finish before it is killed. */
const EXIT_GRACE_MS = 2_000;
const STDERR_TAIL = 2_000;

export function runnerFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'cpsat-runner.exe' : 'cpsat-runner';
}

/**
 * Where the runner lives: `resources/cpsat` in a packaged app (electron-builder.yml
 * extraResources), `.cpsat/host` under the desktop package in development (scripts/
 * fetch-cpsat.mjs). Undefined when it is not there — the caller then reports CP-SAT and hybrid
 * as unavailable and Generate falls back.
 */
export function resolveRunnerPath(options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
}): string | undefined {
  const file = runnerFileName(options.platform);
  const path = options.packaged
    ? join(options.resourcesPath, 'cpsat', file)
    : join(options.appPath, '.cpsat', 'host', file);
  return existsSync(path) ? path : undefined;
}

interface Pending {
  id: string;
  resolve: (result: CpsatResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: CpsatProgress) => void;
}

export class CpsatRunner {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<string> | undefined;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private counter = 0;
  private stderr = '';
  private exited = false;

  /** `command`/`args` are injectable so tests can run a fake runner script under Node. */
  constructor(
    private readonly command: string,
    private readonly args: readonly string[] = [],
  ) {}

  /** The runner's process id while it is running. */
  get pid(): number | undefined {
    return this.exited ? undefined : this.child?.pid;
  }

  /** Spawn if needed and resolve with the OR-Tools version once the runner says it is ready. */
  start(): Promise<string> {
    if (this.ready && !this.exited) return this.ready;
    this.exited = false;
    this.stderr = '';
    const child = spawn(this.command, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`CP-SAT runner did not start within ${READY_TIMEOUT_MS}ms`)),
        READY_TIMEOUT_MS,
      );
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const event = parseEvent(line);
        if (!event) return;
        if (event.type === 'ready') {
          clearTimeout(timer);
          resolve(event.version);
          return;
        }
        this.onEvent(event);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        this.exited = true;
        reject(err);
        this.failPending(new Error(`CP-SAT runner failed: ${err.message}`));
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        this.exited = true;
        const why = `CP-SAT runner exited (${signal ?? `code ${code}`})`;
        reject(new Error(why));
        this.failPending(new Error(this.stderr ? `${why}: ${this.stderr.trim()}` : why));
      });
    });
    return this.ready;
  }

  /** Solve one model; waits behind any solve already running on this runner. */
  solve(
    model: object,
    params: object,
    onProgress?: (progress: CpsatProgress) => void,
  ): Promise<CpsatResult> {
    const run = async (): Promise<CpsatResult> => {
      await this.start();
      const id = `r${++this.counter}`;
      return new Promise<CpsatResult>((resolve, reject) => {
        this.pending = { id, resolve, reject, ...(onProgress ? { onProgress } : {}) };
        this.write({ id, model, params });
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Ask the solve in flight to stop; it still resolves, with the best solution found so far. */
  stop(): void {
    if (this.child && !this.exited) this.write({ stop: true });
  }

  /** Stop any solve, close stdin and make sure the process is gone. */
  dispose(): void {
    const child = this.child;
    if (!child || this.exited) return;
    this.stop();
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), EXIT_GRACE_MS);
    child.once('exit', () => clearTimeout(timer));
  }

  private write(message: object): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onEvent(event: RunnerEvent): void {
    const pending = this.pending;
    if (!pending) return;
    // An unparseable request comes back with an empty id; with one request in flight it is ours.
    if (event.id !== pending.id && !(event.type === 'error' && event.id === '')) return;
    if (event.type === 'progress') {
      pending.onProgress?.(progressOf(event));
    } else if (event.type === 'result') {
      this.pending = undefined;
      pending.resolve({
        ...progressOf(event),
        status: event.status,
        values: event.values.map(Number),
      });
    } else if (event.type === 'error') {
      this.pending = undefined;
      pending.reject(new Error(`CP-SAT runner: ${event.message}`));
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

function progressOf(event: RunnerEvent): CpsatProgress {
  return { objective: event.objective, bound: event.bound, wallMs: Number(event.wall_ms) };
}

function parseEvent(line: string): RunnerEvent | undefined {
  try {
    const value = JSON.parse(line) as RunnerEvent;
    return typeof value?.type === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
