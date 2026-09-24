/**
 * Which backend a Generate actually runs: the manager's one-off choice, else the unit's saved
 * one, falling back along core's `FALLBACK_ORDER` when that backend cannot run on this install.
 *
 * Kept apart from `solver-jobs.ts` (which spawns a worker through an electron-vite import) so the
 * decision is unit-testable on its own. The decision is the part a manager will ask about —
 * "I picked CP-SAT, why did it anneal?" — so it must be exact and say why.
 */

import {
  type ResolvedSolver,
  requiresOrTools,
  resolveSolverId,
  SOLVER_IDS,
  type SolverId,
  type SolverSettings,
} from '@shiftnurse/core';
import type { SolverAvailability } from '../shared/api.js';

export const OR_TOOLS_MISSING = 'The OR-Tools runner is not installed';
export const NOT_IN_THIS_BUILD = 'Not included in this version of ShiftNurse yet';

/**
 * Every backend, marked available unless it needs OR-Tools and either its backend is not part of
 * this build (`orToolsBackends`) or the runner is not installed.
 */
export function solverAvailability(
  orToolsInstalled: boolean,
  orToolsBackends: ReadonlySet<SolverId>,
): SolverAvailability[] {
  return SOLVER_IDS.map((id) => {
    if (!requiresOrTools(id)) return { id, available: true };
    if (!orToolsBackends.has(id)) return { id, available: false, reason: NOT_IN_THIS_BUILD };
    if (!orToolsInstalled) return { id, available: false, reason: OR_TOOLS_MISSING };
    return { id, available: true };
  });
}

export function chooseSolver(
  requested: SolverId | undefined,
  saved: SolverSettings,
  availability: readonly SolverAvailability[],
): ResolvedSolver {
  const available = availability.filter((a) => a.available).map((a) => a.id);
  return resolveSolverId(requested ?? saved.solverId, available);
}
