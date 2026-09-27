/**
 * Planning a batch of Generate runs: how many may run at once, how long the batch will take, and
 * whether the inputs its candidates were solved from are still the inputs today.
 *
 * ## Why OR-Tools runs are not all started at once
 *
 * Each CP-SAT runner already searches with `SEARCH_WORKERS` threads. Starting five of them on an
 * eight-core machine does not finish five times faster — it stretches every run's wall time, and a
 * hybrid whose runner is slow to answer falls back to SA + LNS, which is a *different schedule*.
 * So parallelism is sized to the cores the runs actually use.
 *
 * ## Why a fingerprint rather than an "inputs changed" event
 *
 * Almost every table in the database feeds a solve — roster, leave, locks, rules, census, pay,
 * preferences, history — and a candidate is only worth saving if none of them moved. Hashing the
 * `SolveInput` itself (the one definition of "what the solver read") catches all of them, including
 * ones added later, where a list of events to listen for would silently miss the next new table.
 * The period's unlocked rows are left out: the solver discards them, so editing the draft by hand
 * or saving a sibling candidate does not make the others stale.
 */

import { createHash } from 'node:crypto';
import {
  type Assignment,
  DEFAULT_DETERMINISTIC_TIME,
  SEARCH_WORKERS,
  type SolveInput,
  type SolverId,
} from '@shiftnurse/core';

export const MAX_BATCH_SIZE = 10;

/** Runs that may execute at once for a backend on a machine with `cores` logical CPUs. */
export function batchConcurrency(solver: SolverId, count: number, cores: number): number {
  const slots =
    solver === 'sa-lns'
      ? // One core each; leave one for the main process and the renderer.
        Math.max(1, cores - 1)
      : Math.max(1, Math.floor(cores / SEARCH_WORKERS));
  return Math.max(1, Math.min(count, slots));
}

export interface BatchEstimate {
  /** Expected wall time of one run. */
  perRunMs: number;
  concurrency: number;
  /** Rounds of runs: `ceil(count / concurrency)`. */
  waves: number;
  totalMs: number;
  /** `observed` when a run of this solver on this unit has finished since the app started. */
  basis: 'observed' | 'rough';
}

export interface EstimateInput {
  solver: SolverId;
  count: number;
  cores: number;
  nurses: number;
  days: number;
  maxIterations: number;
  deterministicTime?: number;
  /** The last finished run of this solver on this unit, if any. */
  observedMs?: number;
}

/**
 * Calibrated on `docs/solver-bench.md` (Apple M1): SA + LNS at 200,000 iterations took 1.3 s,
 * 2.5 s and 6.6 s on units of 112, 672 and 1,764 nurse-days — about 3.3 ms per nurse-day plus
 * a fixed 0.8 s. The hybrid's eight CP-SAT windows added 14–30 s on top, growing with the unit;
 * CP-SAT alone ran for close to its budget, about one second per deterministic unit.
 */
const SA_MS_PER_NURSE_DAY = 3.3;
const SA_FIXED_MS = 800;
const SA_CALIBRATION_ITERATIONS = 200_000;
const HYBRID_WINDOWS = 8;
const HYBRID_WINDOW_FIXED_MS = 1700;
const HYBRID_WINDOW_MS_PER_NURSE_DAY = 1.2;
const CPSAT_MS_PER_UNIT = 1000;

function roughPerRunMs(input: EstimateInput): number {
  const nurseDays = input.nurses * input.days;
  const annealMs =
    SA_FIXED_MS +
    SA_MS_PER_NURSE_DAY * nurseDays * (input.maxIterations / SA_CALIBRATION_ITERATIONS);
  switch (input.solver) {
    case 'sa-lns':
      return annealMs;
    case 'hybrid':
      return (
        annealMs +
        HYBRID_WINDOWS * (HYBRID_WINDOW_FIXED_MS + HYBRID_WINDOW_MS_PER_NURSE_DAY * nurseDays)
      );
    case 'cp-sat':
      return (input.deterministicTime ?? DEFAULT_DETERMINISTIC_TIME) * CPSAT_MS_PER_UNIT;
  }
}

export function estimateBatch(input: EstimateInput): BatchEstimate {
  const concurrency = batchConcurrency(input.solver, input.count, input.cores);
  const waves = Math.ceil(input.count / concurrency);
  const observed = input.observedMs !== undefined && input.observedMs > 0;
  const perRunMs = Math.round(observed ? input.observedMs! : roughPerRunMs(input));
  return {
    perRunMs,
    concurrency,
    waves,
    totalMs: perRunMs * waves,
    basis: observed ? 'observed' : 'rough',
  };
}

/** Locked rows in a fixed order: SQLite's `ORDER BY date` leaves ties in whatever order it likes. */
function lockedInOrder(assignments: readonly Assignment[]): Assignment[] {
  const key = (a: Assignment) => `${a.date}|${a.nurseId}|${a.shiftTypeId}|${a.id}`;
  return assignments
    .filter((a) => a.isLocked)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** A digest of everything a solve reads, minus the unlocked draft it throws away. */
export function inputFingerprint(input: SolveInput): string {
  const relevant: SolveInput = { ...input, assignments: lockedInOrder(input.assignments) };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}
