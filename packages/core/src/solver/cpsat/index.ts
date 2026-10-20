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
 * The model is satisfiable by construction: every hard constraint is either standing-aware (a
 * locked breach already counted against its own limit, `atMost`) or on decision variables only
 * (`forbidPair`, bounds), so leaving every variable off always satisfies it — locked shifts and
 * all. INFEASIBLE or MODEL_INVALID therefore means an encoding defect, never the manager's data.
 * `finishCpsat` throws `CpsatInfeasibleError` so the desktop can still hand the manager an
 * SA + LNS schedule while saying it is a bug; the locked breaches it carries are context only.
 *
 * Only UNKNOWN means "ran out of time with nothing": a model with no variables left to decide (no
 * active nurse, every cell locked) is answered OPTIMAL with no values, and that is a schedule —
 * the locked rows.
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
 * CP-SAT called the model contradictory, which a correct encoding never is. `lockedBreaches` are
 * the locked shifts' hard violations, carried as context for the manager — not as the cause.
 */
export class CpsatInfeasibleError extends Error {
  readonly status: CpStatus;
  readonly lockedBreaches: Violation[];

  constructor(status: CpStatus, lockedBreaches: Violation[]) {
    super(
      `CP-SAT reported the model ${status}, which a correct encoding never does (leaving every ` +
        'shift unassigned always satisfies it): this is a bug in the CP-SAT encoding.' +
        (lockedBreaches.length > 0
          ? ` ${lockedBreaches.length} locked-shift breach(es) of a hard rule are listed as ` +
            'context, not as the cause.'
          : ''),
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
  switch (result.status) {
    case 'INFEASIBLE':
    case 'MODEL_INVALID':
      throw new CpsatInfeasibleError(result.status, lockedHardViolations(input));
    case 'UNKNOWN':
      throw new Error('CP-SAT found no schedule within its time budget.');
    case 'OPTIMAL':
    case 'FEASIBLE':
      // A zero-variable model answers OPTIMAL with no values and decodes to the locked rows; a
      // FEASIBLE answer missing values is caught by decode's length check.
      break;
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

export { EncodingDisagreementError } from './decode.js';
export type { CpsatEncoding } from './encode.js';
export { CPSAT_ENCODERS, decisionsFor, encodeCpsat } from './encode.js';
export { DEFAULT_DETERMINISTIC_TIME, SEARCH_WORKERS } from './params.js';
export type { CpModel, CpParameters, CpStatus } from './proto.js';
