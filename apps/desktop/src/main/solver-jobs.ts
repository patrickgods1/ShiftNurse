/**
 * Solve jobs: one worker thread per Generate, tracked so the renderer can poll for progress,
 * cancel, and read the report when it lands.
 *
 * ## Why polling rather than pushing to the renderer
 *
 * The IPC contract is request/response, shaped like the HTTP API it will become, and a
 * long-running job is exactly the kind of thing HTTP handles with "start, then poll status".
 * Pushing progress through `webContents.send` would need a second channel the preload does
 * not expose and a web client could not subscribe to. A 250ms poll of a plain status object
 * costs nothing and keeps the renderer's view of a run identical to what a browser would see.
 *
 * ## Why the result is applied here, not by the renderer
 *
 * A finished solve must land in the database in one transaction, with its audit entry, whether
 * or not the schedule page is still open. Applying from the worker's `done` message on the main
 * thread means a manager who navigates away mid-solve still gets their schedule, and the
 * renderer only ever reads state — it never carries 800 assignments back across IPC.
 *
 * This module knows nothing about the database: the caller injects how to load a period's
 * input and how to persist a report, so the job mechanics are the same for any solver backend.
 */

import type { Worker } from 'node:worker_threads';
import type { Id, SolveInput, SolveReport, SolverSettings } from '@shiftnurse/core';
import type { SolveJobOptions, SolveJobStatus, SolverAvailability } from '../shared/api.js';
import { chooseSolver } from './solver-choice.js';
import spawnSolverWorker from './solver-worker?nodeWorker';
import type { SolverWorkerData, SolverWorkerMessage } from './solver-worker.js';

/** Enough iterations to settle a six-week, 40-nurse unit (~8s in the worker). */
const DEFAULT_MAX_ITERATIONS = 200_000;
/** A safety valve well past any plausible run; only a runaway input ever hits it. */
const TIME_LIMIT_MS = 5 * 60 * 1000;
const PROGRESS_EVERY_ITERATIONS = 2000;

export interface SolverJobsDeps {
  /** Assemble the plain-data input for a draft period; throws if the period cannot be solved. */
  loadInput(periodId: Id): SolveInput;
  /** Persist a finished report into the period, preserving locked rows. */
  apply(periodId: Id, report: SolveReport): { created: number; preservedLocked: number };
  /** The period's unit's saved solver choice. */
  settings(periodId: Id): SolverSettings;
  /** Which backends can run on this install. */
  availability(): SolverAvailability[];
  /** The CP-SAT runner binary, when installed. */
  runnerPath?(): string | undefined;
  now?: () => number;
}

interface Job {
  status: SolveJobStatus;
  worker: Worker;
  cancelFlag: Int32Array;
  /** The CP-SAT runner the worker spawned, if any: killed with the job. */
  runnerPid?: number;
}

/**
 * A stable seed per period: "re-run Generate on unchanged inputs → identical schedule" holds
 * because the seed is a function of the period, not of the clock. FNV-1a, 32-bit.
 */
export function seedFor(periodId: Id): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < periodId.length; i++) {
    hash ^= periodId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class SolverJobs {
  private readonly jobs = new Map<Id, Job>();
  private counter = 0;
  private readonly now: () => number;

  constructor(private readonly deps: SolverJobsDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(periodId: Id, options: SolveJobOptions = {}): SolveJobStatus {
    const running = [...this.jobs.values()].find(
      (j) => j.status.periodId === periodId && j.status.state === 'running',
    );
    if (running) {
      throw new Error(
        `A solve is already running for period ${periodId} (job ${running.status.id})`,
      );
    }

    const input = this.deps.loadInput(periodId);
    const seed = options.seed ?? seedFor(periodId);
    const saved = this.deps.settings(periodId);
    const choice = chooseSolver(options.solver, saved, this.deps.availability());
    const id = `solve-${++this.counter}-${this.now()}`;
    const cancelBuffer = new SharedArrayBuffer(4);
    const cancelFlag = new Int32Array(cancelBuffer);

    const workerData: SolverWorkerData = {
      input,
      solverId: choice.id,
      ...(choice.fellBackFrom ? { fellBackFrom: choice.fellBackFrom } : {}),
      options: {
        seed,
        maxIterations: options.maxIterations ?? saved.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        timeLimitMs: TIME_LIMIT_MS,
        progressEveryIterations: PROGRESS_EVERY_ITERATIONS,
      },
      cancelFlag: cancelBuffer,
      ...(this.deps.runnerPath?.() ? { runnerPath: this.deps.runnerPath()! } : {}),
      ...(options.deterministicTime !== undefined
        ? { deterministicTime: options.deterministicTime }
        : {}),
    };
    const worker = spawnSolverWorker({ workerData });
    const status: SolveJobStatus = {
      id,
      periodId,
      seed,
      solver: choice.id,
      ...(choice.fellBackFrom ? { fellBackFrom: choice.fellBackFrom } : {}),
      state: 'running',
      startedAt: this.now(),
    };
    const job: Job = { status, worker, cancelFlag };
    this.jobs.set(id, job);

    worker.on('message', (message: SolverWorkerMessage) => this.onMessage(job, message));
    worker.on('error', (err) => this.finish(job, 'failed', { error: err.message }));
    worker.on('exit', (code) => {
      // A clean exit after `done` is the normal path; anything else while we still think the
      // job is running means the thread died without reporting.
      if (job.status.state === 'running') {
        this.finish(job, 'failed', { error: `solver worker exited with code ${code}` });
      }
    });
    return this.snapshot(job);
  }

  status(jobId: Id): SolveJobStatus | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : undefined;
  }

  cancel(jobId: Id): SolveJobStatus | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.status.state === 'running') Atomics.store(job.cancelFlag, 0, 1);
    return this.snapshot(job);
  }

  /** Stop every worker; called on app quit so a solve never outlives the database handle. */
  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.status.state !== 'running') continue;
      void job.worker.terminate();
      // A terminated worker cannot stop the runner it spawned; closing its pipes would only let
      // the search run out its budget. Kill it.
      if (job.runnerPid !== undefined) {
        try {
          process.kill(job.runnerPid);
        } catch {
          // Already gone.
        }
      }
    }
  }

  private onMessage(job: Job, message: SolverWorkerMessage): void {
    switch (message.type) {
      case 'progress':
        job.status.progress = message.progress;
        return;
      case 'runner':
        job.runnerPid = message.pid;
        return;
      case 'error':
        this.finish(job, 'failed', { error: message.message });
        return;
      case 'done': {
        job.status.report = message.report;
        // The report is the last word on who solved it: a hybrid whose runner failed mid-run
        // finishes as SA + LNS and says why, and the dialog reads the status, not the report.
        job.status.solver = message.report.stats.solver;
        const fellBack = message.report.stats.fellBackFrom ?? job.status.fellBackFrom;
        if (fellBack) job.status.fellBackFrom = fellBack;
        if (message.report.stats.cancelled) {
          this.finish(job, 'cancelled', {});
          return;
        }
        job.status.state = 'applying';
        try {
          const applied = this.deps.apply(job.status.periodId, message.report);
          this.finish(job, 'done', { applied });
        } catch (err) {
          this.finish(job, 'failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  private finish(
    job: Job,
    state: 'done' | 'failed' | 'cancelled',
    extra: Partial<Pick<SolveJobStatus, 'applied' | 'error'>>,
  ): void {
    job.status.state = state;
    job.status.finishedAt = this.now();
    if (extra.applied) job.status.applied = extra.applied;
    if (extra.error) job.status.error = extra.error;
  }

  /** A copy, so the renderer's structured clone never races the worker's next update. */
  private snapshot(job: Job): SolveJobStatus {
    return { ...job.status };
  }
}
