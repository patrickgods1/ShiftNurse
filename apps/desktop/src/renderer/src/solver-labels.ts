/**
 * How each solver backend is named and explained to a manager — shared by Settings › Solver and
 * the Generate dialog so the two never describe the same choice differently.
 */

import type { SolverId } from '@shiftnurse/core';

export const SOLVER_LABELS: Record<SolverId, { name: string; summary: string }> = {
  hybrid: {
    name: 'Hybrid (recommended)',
    summary:
      'Anneals the whole period, then re-optimises the hardest few days exactly with CP-SAT. ' +
      'Best overall quality; needs the OR-Tools runner.',
  },
  'sa-lns': {
    name: 'Simulated annealing + LNS',
    summary:
      'Fast local search that always finishes with a usable schedule. Cannot prove how close to ' +
      'optimal it is. Runs on every install.',
  },
  'cp-sat': {
    name: 'CP-SAT (exact)',
    summary:
      'Solves the whole period as one constraint model and reports how far from optimal the ' +
      'result can be. Slower on large units; needs the OR-Tools runner.',
  },
};

/** The display order: the recommended default first. */
export const SOLVER_ORDER: readonly SolverId[] = ['hybrid', 'sa-lns', 'cp-sat'];
