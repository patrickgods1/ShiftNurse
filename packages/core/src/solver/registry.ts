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
 * Provisional until the M15 benchmark: hybrid first, then whichever of SA + LNS / CP-SAT scores
 * the lower objective on the demo and fixture units (docs/SOLVER_PLAN.md, task 5.9).
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
