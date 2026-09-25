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
 */

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
    // Every constraint is satisfiable by leaving the variables off, so this is an encoding bug.
    throw new Error(`CP-SAT reported the model ${result.status}; this is a bug in the encoding.`);
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
export type { CpModel, CpParameters, CpStatus } from './proto.js';
