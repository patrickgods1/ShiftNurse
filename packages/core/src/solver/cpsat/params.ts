/**
 * The CP-SAT parameters every ShiftNurse solve uses.
 *
 * Reproducibility first: a seed derived from the period and a budget in *deterministic* time
 * (CP-SAT's own work counter), so regenerating unchanged inputs yields the same schedule — the
 * same promise the annealer makes with its iteration budget. CP-SAT's strength is its portfolio
 * of different search workers; racing them in parallel would make the winner depend on the
 * machine's load, so `interleave_search` runs a fixed number of them in deterministic turns
 * instead. The count is fixed, not the machine's core count, so every install searches the
 * same way; more cores only make it finish sooner. On a 14-day, 8-nurse test unit, 8 interleaved
 * workers filled every floor in ~2 s where one worker left one short after 19 s.
 * The wall-clock limit is only a safety valve.
 */

import type { CpParameters } from './proto.js';

export const DEFAULT_DETERMINISTIC_TIME = 60;
export const SEARCH_WORKERS = 8;

export function cpsatParameters(options: {
  seed: number;
  deterministicTime?: number;
  timeLimitMs?: number;
}): CpParameters {
  return {
    num_workers: SEARCH_WORKERS,
    interleave_search: true,
    // SatParameters.random_seed is an int32.
    random_seed: options.seed % 2147483647,
    max_deterministic_time: options.deterministicTime ?? DEFAULT_DETERMINISTIC_TIME,
    ...(options.timeLimitMs !== undefined
      ? { max_time_in_seconds: options.timeLimitMs / 1000 }
      : {}),
  };
}
