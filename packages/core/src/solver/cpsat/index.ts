/**
 * The CP-SAT backend's two pure halves, around the one impure step core may not take.
 *
 * CP-SAT is Google OR-Tools' constraint solver (Laurent Perron, Frédéric Didier and the OR-Tools
 * team; Apache-2.0; https://developers.google.com/optimization/cp/cp_solver). It runs in the
 * native runner (native/cpsat-runner); credits and citations are in README.md.
 *
 *   prepareCpsat(input)  → model + parameters      (here)
 *   runner.solve(model)  → values, objective, bound (desktop: a subprocess)
 *   finishCpsat(result)  → SolveReport              (here)
 *
 * The report comes from the same `buildReport` as the annealer's, over a `SolverModel` the
 * answer was loaded into through the rule gate — so a CP-SAT schedule is judged, priced and
 * summarised by exactly the machinery that judges the grid.
 *
 * ## Why INFEASIBLE is a typed error
 *
 * Every constraint is satisfiable by leaving every decision variable off, but a locked shift is a
 * constant: a locked turnaround with no waiver, or an accommodation block added after the lock,
 * makes the model contradictory. `finishCpsat` throws `CpsatInfeasibleError` naming those locked
 * breaches, so the desktop can run SA + LNS — which measures around them — and tell the manager
 * which pins to look at, instead of failing the Generate.
 */

import type { Violation } from '../../rules/types.js';
import { greedySeed } from '../greedy.js';
import { SolverModel } from '../model.js';
import { buildReport } from '../report.js';
import type { ObjectiveWeights, SolveInput, SolveReport } from '../types.js';
import { decodeCpsat } from './decode.js';
import { type CpsatEncoding, encodeCpsat } from './encode.js';
import { cpsatParameters } from './params.js';
import type { CpModel, CpParameters, CpStatus } from './proto.js';

export interface CpsatJob {
  model: CpModel;
  params: CpParameters;
  encoding: CpsatEncoding;
  /** Objective of the greedy seed used as the search hint, for `SolveStats.seedObjective`. */
  seedObjective: number;
}

export interface CpsatResult {
  status: CpStatus;
  values: readonly number[];
  objective: number;
  bound: number;
}

/**
 * CP-SAT found the model contradictory. `lockedBreaches` are the locked shifts' hard violations —
 * the only constants that can do that; empty means the encoding itself is wrong.
 */
export class CpsatInfeasibleError extends Error {
  readonly status: CpStatus;
  readonly lockedBreaches: Violation[];

  constructor(status: CpStatus, lockedBreaches: Violation[]) {
    super(
      lockedBreaches.length > 0
        ? `CP-SAT reported the model ${status}: ${lockedBreaches.length} locked-shift breach(es) of a hard rule.`
        : `CP-SAT reported the model ${status} with no locked shift breaching a hard rule; this is a bug in the encoding.`,
    );
    this.name = 'CpsatInfeasibleError';
    this.status = status;
    this.lockedBreaches = lockedBreaches;
  }
}

/**
 * The hard nurse-scope violations (floors aside) that the input's locked shifts already carry,
 * judged with the lookback tail by the same gate the annealer uses.
 */
export function lockedHardViolations(input: SolveInput): Violation[] {
  return new SolverModel(input).lockedHardViolations();
}

export function prepareCpsat(
  input: SolveInput,
  options: {
    seed: number;
    deterministicTime?: number;
    timeLimitMs?: number;
    weights?: Partial<ObjectiveWeights>;
  },
): CpsatJob {
  // The greedy seed is a legal, floor-first schedule in milliseconds: a hint that gives CP-SAT a
  // good incumbent before its first second of search.
  const seedModel = new SolverModel(input, options.weights);
  greedySeed(seedModel);
  const hint = seedModel.assignments();
  const encoding = encodeCpsat(input, {
    ...(options.weights ? { weights: options.weights } : {}),
    hint,
  });
  return {
    model: encoding.model,
    params: cpsatParameters(options),
    encoding,
    seedObjective: seedModel.objective(),
  };
}

export function finishCpsat(
  input: SolveInput,
  job: CpsatJob,
  result: CpsatResult,
  run: {
    seed: number;
    elapsedMs: number;
    improvements: number;
    cancelled: boolean;
    timedOut: boolean;
  },
): SolveReport {
  if (result.status === 'INFEASIBLE' || result.status === 'MODEL_INVALID') {
    // Leaving every variable off satisfies every constraint, so only the locked shifts — the
    // model's constants — can make it contradictory. Name them; none means an encoding bug.
    throw new CpsatInfeasibleError(result.status, lockedHardViolations(input));
  }
  if (result.values.length === 0) {
    throw new Error('CP-SAT found no schedule within its time budget.');
  }
  const model = decodeCpsat(input, job.encoding, result.values);
  const objective = model.objective();
  const bound = Math.min(result.bound, objective);
  return buildReport(model, {
    solver: 'cp-sat',
    bound,
    gap: objective > 0 ? Math.max(0, (objective - bound) / objective) : 0,
    seed: run.seed,
    iterations: 0,
    accepted: 0,
    improvements: run.improvements,
    elapsedMs: run.elapsedMs,
    cancelled: run.cancelled,
    timedOut: run.timedOut,
    seedObjective: job.seedObjective,
  });
}

export type { CpsatEncoding } from './encode.js';
export { CPSAT_ENCODERS, decisionsFor, encodeCpsat } from './encode.js';
export { DEFAULT_DETERMINISTIC_TIME, SEARCH_WORKERS } from './params.js';
export type { CpModel, CpParameters, CpStatus } from './proto.js';
