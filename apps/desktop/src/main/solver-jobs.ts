/**
 * Solve batches: Generate runs N variations of a period — one worker thread per run, seeds
 * `base + k` — and keeps each finished report as a *candidate* the manager can page through,
 * compare and preview. Nothing is written to the draft until one is saved.
 *
 * ## Why candidates rather than applying the run
 *
 * Variations of the same inputs differ by a percent or two in total score; what differs is the
 * trade — who carries the weekends, how much overtime, whose preferences give way. That is the
 * manager's call, and they cannot make it if each run overwrites the last. So a finished run is
 * held here, in memory, until it is saved, discarded, replaced by the next Generate, or made
 * stale by a change to anything the solver read (see `inputFingerprint`).
 *
 * ## Why polling rather than pushing to the renderer
 *
 * The IPC contract is request/response, shaped like the HTTP API it will become, and a
 * long-running job is exactly the kind of thing HTTP handles with "start, then poll status".
 * Pushing progress through `webContents.send` would need a second channel the preload does
 * not expose and a web client could not subscribe to. A 250ms poll of a plain status object
 * costs nothing and keeps the renderer's view of a run identical to what a browser would see.
 *
 * ## Determinism
 *
 * Variation n of a period is seeded `seedFor(period) + n - 1`, so variation 1 is the schedule a
 * single Generate always gave, and the same inputs give the same variation for the same number
 * however many ran at once: each run's schedule depends only on its input and seed, never on
 * which finished first. A batch started with `continueAfter` carries the numbering on (a second
 * batch of three is variations 4–6), so generating again searches seeds not yet tried instead of
 * repeating the first batch.
 *
 * This module knows nothing about the database: the caller injects how to load a period's
 * input and how to start a worker, so the batch mechanics are testable without either.
 */

import {
  daysBetween,
  type Id,
  type SolveInput,
  type SolveReport,
  type SolverSettings,
} from '@shiftnurse/core';
import type {
  SolveBatchOptions,
  SolveBatchStatus,
  SolveEstimate,
  SolveRunStatus,
  SolverAvailability,
} from '../shared/api.js';
import { chooseSolver } from './solver-choice.js';
import {
  batchConcurrency,
  estimateBatch,
  inputFingerprint,
  MAX_BATCH_SIZE,
} from './solver-plan.js';
import type { SolverWorkerData, SolverWorkerMessage } from './solver-worker.js';

/** Enough iterations to settle a six-week, 40-nurse unit (~8s in the worker). */
const DEFAULT_MAX_ITERATIONS = 200_000;
/** A safety valve well past any plausible run; only a runaway input ever hits it. */
const TIME_LIMIT_MS = 5 * 60 * 1000;
const PROGRESS_EVERY_ITERATIONS = 2000;

/** The part of a `worker_threads` Worker a batch uses; a fake stands in for it in tests. */
export interface SolverWorkerHandle {
  on(event: 'message', listener: (message: SolverWorkerMessage) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): unknown;
}

export interface SolverJobsDeps {
  /** Assemble the plain-data input for a draft period; throws if the period cannot be solved. */
  loadInput(periodId: Id): SolveInput;
  /** The period's unit's saved solver choice. */
  settings(periodId: Id): SolverSettings;
  /** Which backends can run on this install. */
  availability(): SolverAvailability[];
  /** The CP-SAT runner binary, when installed. */
  runnerPath?(): string | undefined;
  spawnWorker(data: SolverWorkerData): SolverWorkerHandle;
  /**
   * The schedule on the grid, scored by the objective every variation is scored by; undefined
   * when the grid is empty. Without it a variation could be called best while the manager
   * already has a better schedule.
   */
  scoreDraft?(input: SolveInput): number | undefined;
  /** Logical CPUs available to the batch. */
  cores(): number;
  now?: () => number;
}

interface Run {
  status: SolveRunStatus;
  worker?: SolverWorkerHandle;
  cancelFlag?: Int32Array;
  /** The CP-SAT runner the worker spawned, if any: killed with the run. */
  runnerPid?: number;
  report?: SolveReport;
}

interface Batch {
  status: Omit<SolveBatchStatus, 'runs'>;
  runs: Run[];
  input: SolveInput;
  fingerprint: string;
  workerData: Omit<SolverWorkerData, 'options' | 'cancelFlag'> & {
    options: Omit<SolverWorkerData['options'], 'seed'>;
  };
}

/** A finished run, with the input it was solved from. */
export interface Candidate {
  index: number;
  batch: SolveBatchStatus;
  input: SolveInput;
  report: SolveReport;
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

/**
 * A run is only a guide to one with the same solver and budget: a 20,000-iteration run says
 * little about a 200,000-iteration one.
 */
function observationKey(
  unitId: Id,
  solver: string,
  budget: { options: { maxIterations: number }; deterministicTime?: number },
): string {
  return `${unitId}:${solver}:${budget.options.maxIterations}:${budget.deterministicTime ?? ''}`;
}

function clampCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return 1;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(count)));
}

export class SolverJobs {
  private readonly batches = new Map<Id, Batch>();
  /** Last finished run's wall time per unit, solver and budget, for the estimate. */
  private readonly observedMs = new Map<string, number>();
  private counter = 0;
  private readonly now: () => number;

  constructor(private readonly deps: SolverJobsDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(periodId: Id, options: SolveBatchOptions = {}): SolveBatchStatus {
    const previous = this.batchForPeriod(periodId);
    if (previous?.status.state === 'running') {
      throw new Error(`A solve is already running for period ${periodId} (${previous.status.id})`);
    }
    const offset = this.offsetAfter(periodId, options.continueAfter);
    if (previous) this.drop(previous);

    const input = this.deps.loadInput(periodId);
    const count = clampCount(options.count);
    const baseSeed = options.seed ?? seedFor(periodId);
    const saved = this.deps.settings(periodId);
    const choice = chooseSolver(options.solver, saved, this.deps.availability());
    const concurrency = batchConcurrency(choice.id, count, this.deps.cores());
    const runnerPath = this.deps.runnerPath?.();
    const id = `batch-${++this.counter}-${this.now()}`;

    const batch: Batch = {
      status: {
        id,
        periodId,
        solver: choice.id,
        ...(choice.fellBackFrom ? { fellBackFrom: choice.fellBackFrom } : {}),
        state: 'running',
        cancelled: false,
        count,
        offset,
        concurrency,
        startedAt: this.now(),
      },
      runs: Array.from({ length: count }, (_, index) => ({
        status: {
          index,
          seed: (baseSeed + offset + index) >>> 0,
          solver: choice.id,
          state: 'queued',
        },
      })),
      input,
      fingerprint: inputFingerprint(input),
      workerData: {
        input,
        solverId: choice.id,
        ...(choice.fellBackFrom ? { fellBackFrom: choice.fellBackFrom } : {}),
        options: {
          maxIterations: options.maxIterations ?? saved.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          timeLimitMs: TIME_LIMIT_MS,
          progressEveryIterations: PROGRESS_EVERY_ITERATIONS,
        },
        ...(runnerPath ? { runnerPath } : {}),
        ...(options.deterministicTime !== undefined
          ? { deterministicTime: options.deterministicTime }
          : {}),
      },
    };
    this.scoreDraftInto(batch, input);
    this.batches.set(id, batch);
    this.pump(batch);
    return this.snapshot(batch);
  }

  status(batchId: Id): SolveBatchStatus | undefined {
    const batch = this.batches.get(batchId);
    return batch ? this.snapshot(batch) : undefined;
  }

  /**
   * The period's batch, checked against today's inputs. A stale batch keeps its status — so the
   * renderer can say why its candidates vanished — but loses its reports and cannot be saved.
   */
  current(periodId: Id): SolveBatchStatus | undefined {
    const batch = this.batchForPeriod(periodId);
    if (!batch) return undefined;
    this.checkFresh(batch);
    return this.snapshot(batch);
  }

  cancel(batchId: Id): SolveBatchStatus | undefined {
    const batch = this.batches.get(batchId);
    if (!batch) return undefined;
    if (batch.status.state === 'running') {
      batch.status.cancelled = true;
      for (const run of batch.runs) {
        if (run.status.state === 'queued') run.status.state = 'cancelled';
        if (run.status.state === 'running' && run.cancelFlag) Atomics.store(run.cancelFlag, 0, 1);
      }
      this.settleIfIdle(batch);
    }
    return this.snapshot(batch);
  }

  discard(batchId: Id): void {
    const batch = this.batches.get(batchId);
    if (batch) this.drop(batch);
  }

  estimate(periodId: Id, options: SolveBatchOptions = {}): SolveEstimate {
    const input = this.deps.loadInput(periodId);
    const saved = this.deps.settings(periodId);
    const choice = chooseSolver(options.solver, saved, this.deps.availability());
    const count = clampCount(options.count);
    const maxIterations = options.maxIterations ?? saved.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const observedMs = this.observedMs.get(
      observationKey(input.unit.id, choice.id, {
        options: { maxIterations },
        ...(options.deterministicTime !== undefined
          ? { deterministicTime: options.deterministicTime }
          : {}),
      }),
    );
    const days = daysBetween(input.period.startDate, input.period.endDate) + 1;
    return {
      solver: choice.id,
      count,
      ...estimateBatch({
        solver: choice.id,
        count,
        cores: this.deps.cores(),
        nurses: input.nurses.filter((n) => n.active).length,
        days,
        maxIterations,
        ...(options.deterministicTime !== undefined
          ? { deterministicTime: options.deterministicTime }
          : {}),
        ...(observedMs !== undefined ? { observedMs } : {}),
      }),
    };
  }

  /**
   * A finished run, re-checked against today's inputs first. Throws — with the reason the
   * manager will read — when there is nothing to hand back.
   */
  candidate(batchId: Id, index: number): Candidate {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error('These variations are gone; generate again');
    this.checkFresh(batch);
    if (batch.status.stale) throw new Error(batch.status.stale);
    const run = batch.runs[index];
    if (!run) throw new Error(`Variation ${index + 1} does not exist`);
    if (run.status.state !== 'done' || !run.report) {
      throw new Error(`Variation ${index + 1} has not finished`);
    }
    return { index, batch: this.snapshot(batch), input: batch.input, report: run.report };
  }

  /** Every finished run of a fresh batch, in run order. */
  candidates(batchId: Id): Candidate[] {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error('These variations are gone; generate again');
    this.checkFresh(batch);
    if (batch.status.stale) throw new Error(batch.status.stale);
    const snapshot = this.snapshot(batch);
    return batch.runs.flatMap((run) =>
      run.status.state === 'done' && run.report
        ? [{ index: run.status.index, batch: snapshot, input: batch.input, report: run.report }]
        : [],
    );
  }

  /**
   * Finished variations in batches nothing has been saved from: what quitting would throw away,
   * since batches live in memory only. A stale batch is not counted — it cannot be saved.
   */
  unsavedVariations(): number {
    let count = 0;
    for (const batch of this.batches.values()) {
      if (batch.status.stale || batch.status.saved !== undefined) continue;
      count += batch.runs.filter((r) => r.status.state === 'done' && r.report).length;
    }
    return count;
  }

  markSaved(batchId: Id, index: number): void {
    const batch = this.batches.get(batchId);
    if (batch) batch.status.saved = index;
  }

  /** Stop every worker; called on app quit so a solve never outlives the database handle. */
  dispose(): void {
    for (const batch of [...this.batches.values()]) this.drop(batch);
  }

  // -------------------------------------------------------------------------

  /**
   * Where a new batch starts in the period's sequence of variations: after `continueAfter`'s,
   * so "Generate again" tries seeds no batch has tried — or at variation 1, which on unchanged
   * inputs repeats the first batch exactly.
   */
  private offsetAfter(periodId: Id, continueAfter: Id | undefined): number {
    if (continueAfter === undefined) return 0;
    const previous = this.batches.get(continueAfter);
    if (!previous || previous.status.periodId !== periodId) {
      throw new Error('The variations to continue from are gone; generate from variation 1');
    }
    return previous.status.offset + previous.status.count;
  }

  private batchForPeriod(periodId: Id): Batch | undefined {
    return [...this.batches.values()].find((b) => b.status.periodId === periodId);
  }

  private checkFresh(batch: Batch): void {
    if (batch.status.stale) return;
    let reason: string | undefined;
    try {
      const input = this.deps.loadInput(batch.status.periodId);
      if (inputFingerprint(input) !== batch.fingerprint) {
        reason =
          'Something these variations were solved from has changed since they were generated';
      } else {
        // The grid may have changed (a hand edit, a saved variation) without making the batch
        // stale: its score is what the variations are measured against.
        this.scoreDraftInto(batch, input);
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (reason === undefined) return;
    batch.status.stale = reason;
    this.stopRuns(batch);
    for (const run of batch.runs) {
      delete run.report;
      if (run.status.state === 'queued' || run.status.state === 'running') {
        run.status.state = 'cancelled';
      }
    }
    delete batch.status.best;
    delete batch.status.draftObjective;
    this.settleIfIdle(batch);
  }

  private scoreDraftInto(batch: Batch, input: SolveInput): void {
    const score = this.deps.scoreDraft?.(input);
    if (score === undefined) delete batch.status.draftObjective;
    else batch.status.draftObjective = score;
  }

  private pump(batch: Batch): void {
    if (batch.status.cancelled || batch.status.stale) return;
    let running = batch.runs.filter((r) => r.status.state === 'running').length;
    for (const run of batch.runs) {
      if (running >= batch.status.concurrency) break;
      if (run.status.state !== 'queued') continue;
      this.launch(batch, run);
      running++;
    }
  }

  private launch(batch: Batch, run: Run): void {
    const cancelBuffer = new SharedArrayBuffer(4);
    run.cancelFlag = new Int32Array(cancelBuffer);
    run.status.state = 'running';
    run.status.startedAt = this.now();
    const worker = this.deps.spawnWorker({
      ...batch.workerData,
      options: { ...batch.workerData.options, seed: run.status.seed },
      cancelFlag: cancelBuffer,
    });
    run.worker = worker;
    worker.on('message', (message) => this.onMessage(batch, run, message));
    worker.on('error', (err) => this.finishRun(batch, run, 'failed', err.message));
    worker.on('exit', (code) => {
      // A clean exit after `done` is the normal path; anything else while we still think the
      // run is going means the thread died without reporting.
      if (run.status.state === 'running') {
        this.finishRun(batch, run, 'failed', `solver worker exited with code ${code}`);
      }
    });
  }

  private onMessage(batch: Batch, run: Run, message: SolverWorkerMessage): void {
    if (run.status.state !== 'running') return;
    switch (message.type) {
      case 'progress':
        run.status.progress = message.progress;
        return;
      case 'runner':
        run.runnerPid = message.pid;
        return;
      case 'error':
        this.finishRun(batch, run, 'failed', message.message);
        return;
      case 'done': {
        const { report } = message;
        // The report is the last word on who solved it: a hybrid whose runner failed mid-run
        // finishes as SA + LNS and says why.
        run.status.solver = report.stats.solver;
        const fellBack = report.stats.fellBackFrom ?? batch.status.fellBackFrom;
        if (fellBack) run.status.fellBackFrom = fellBack;
        // A stopped run's best-so-far is not a candidate: the manager said stop.
        if (report.stats.cancelled) {
          this.finishRun(batch, run, 'cancelled');
          return;
        }
        if (!batch.status.stale) run.report = report;
        run.status.summary = {
          objective: report.objective.total,
          digest: report.digest,
          ...(report.cost
            ? {
                costTotal: report.cost.totals.total,
                overtimeHours: report.cost.totals.overtimeHours,
              }
            : {}),
          floorsShort: report.unfilled.reduce((sum, slot) => sum + slot.shortfall, 0),
          unfilledSlots: report.unfilled.length,
          hardViolations: report.hardViolations.length,
          softViolations: report.softViolations.length,
          elapsedMs: report.stats.elapsedMs,
          ...(report.stats.gap !== undefined ? { gap: report.stats.gap } : {}),
          ...(report.stats.windows ? { windows: report.stats.windows } : {}),
        };
        this.observedMs.set(
          observationKey(batch.input.unit.id, report.stats.solver, batch.workerData),
          report.stats.elapsedMs,
        );
        this.finishRun(batch, run, 'done');
      }
    }
  }

  private finishRun(
    batch: Batch,
    run: Run,
    state: 'done' | 'failed' | 'cancelled',
    error?: string,
  ): void {
    run.status.state = state;
    run.status.finishedAt = this.now();
    if (error !== undefined) run.status.error = error;
    delete run.worker;
    delete run.runnerPid;
    this.pump(batch);
    this.settleIfIdle(batch);
  }

  private settleIfIdle(batch: Batch): void {
    const busy = batch.runs.some(
      (r) => r.status.state === 'queued' || r.status.state === 'running',
    );
    if (busy || batch.status.state === 'done') return;
    batch.status.state = 'done';
    batch.status.finishedAt = this.now();
    let best: Run | undefined;
    for (const run of batch.runs) {
      if (run.status.state !== 'done' || !run.report) continue;
      if (!best || run.report.objective.total < best.report!.objective.total) best = run;
    }
    if (best) batch.status.best = best.status.index;
  }

  private stopRuns(batch: Batch): void {
    for (const run of batch.runs) {
      if (!run.worker) continue;
      void run.worker.terminate();
      // A terminated worker cannot stop the runner it spawned; closing its pipes would only let
      // the search run out its budget. Kill it.
      if (run.runnerPid !== undefined) {
        try {
          process.kill(run.runnerPid);
        } catch {
          // Already gone.
        }
      }
      delete run.worker;
      delete run.runnerPid;
    }
  }

  private drop(batch: Batch): void {
    this.stopRuns(batch);
    this.batches.delete(batch.status.id);
  }

  /** A copy, so the renderer's structured clone never races the worker's next update. */
  private snapshot(batch: Batch): SolveBatchStatus {
    return { ...batch.status, runs: batch.runs.map((r) => ({ ...r.status })) };
  }
}
