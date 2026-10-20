/**
 * Which solver backends exist, which one a unit gets by default, and what runs when the chosen
 * one cannot.
 *
 * ## Why a fallback instead of an error
 *
 * CP-SAT and the hybrid need the OR-Tools runner, a native binary bundled per platform. A
 * missing or broken binary must not leave a manager unable to generate a schedule on the day
 * it is due, so a request for an unavailable backend resolves to the next available one in
 * `FALLBACK_ORDER`, and the report says which ran and why (`SolveStats.fellBackFrom`). SA + LNS
 * is pure TypeScript and is always available, so resolution only fails if the caller claims
 * nothing at all can run.
 *
 * The same holds when CP-SAT runs but finds the model INFEASIBLE. A correct encoding is never
 * infeasible (every variable off satisfies it), so that is an encoding bug; the desktop's
 * `solveCpsat` still runs SA + LNS so the manager gets a schedule, and says it is a bug.
 *
 * Only the pure backends are registered here. The OR-Tools ones talk to a subprocess, which
 * core may not do; the desktop main process registers them next to the runner.
 */

import { localSearchSolver } from './solver.js';
import type { Solver, SolverId } from './types.js';

export const SOLVER_IDS: readonly SolverId[] = ['hybrid', 'sa-lns', 'cp-sat'];

export const DEFAULT_SOLVER_ID: SolverId = 'hybrid';

/** A unit's saved choice. `maxIterations` absent means the job's default budget. */
export interface SolverSettings {
  solverId: SolverId;
  maxIterations?: number;
}

export const DEFAULT_SOLVER_SETTINGS: SolverSettings = { solverId: DEFAULT_SOLVER_ID };

/**
 * Measured by `npm run bench:solvers` (docs/solver-bench.md, 2026-10-19): the hybrid had the best
 * median objective on the demo unit (−5% vs SA + LNS, every floor filled) and a 24-nurse synthetic
 * unit (−6%), and was within 2 points of SA + LNS on a small tight one. Whole-period CP-SAT lost to
 * SA + LNS on all three — on the demo it left 13–17 floors short (up to 8 on one shift) against
 * 0–2 — so it comes last.
 */
export const FALLBACK_ORDER: readonly SolverId[] = ['hybrid', 'sa-lns', 'cp-sat'];

export const PURE_SOLVERS: Partial<Record<SolverId, Solver>> = { 'sa-lns': localSearchSolver };

export function requiresOrTools(id: SolverId): boolean {
  return PURE_SOLVERS[id] === undefined;
}

export function isSolverId(value: unknown): value is SolverId {
  return typeof value === 'string' && (SOLVER_IDS as readonly string[]).includes(value);
}

export interface ResolvedSolver {
  id: SolverId;
  fellBackFrom?: { solver: SolverId; reason: string };
}

/** The requested backend if it can run, else the first available one in `FALLBACK_ORDER`. */
export function resolveSolverId(
  requested: SolverId,
  available: readonly SolverId[],
): ResolvedSolver {
  if (available.includes(requested)) return { id: requested };
  const id = FALLBACK_ORDER.find((candidate) => available.includes(candidate));
  if (!id) throw new Error('No solver is available to run');
  return {
    id,
    fellBackFrom: {
      solver: requested,
      reason: requiresOrTools(requested)
        ? `${requested} is not available: the OR-Tools runner is not installed`
        : `${requested} is not available`,
    },
  };
}
