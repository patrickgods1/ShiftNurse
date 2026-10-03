/**
 * How each solver backend is named and explained to a manager — shared by Settings › Solver and
 * the Generate dialog so the two never describe the same choice differently.
 */

import type { SolverId } from '@shiftnurse/core';

export const SOLVER_LABELS: Record<SolverId, { name: string; summary: string; technical: string }> =
  {
    hybrid: {
      name: 'Best schedule (recommended)',
      summary:
        'Searches widely, then re-checks the hardest few days exactly. The best schedules in ' +
        'testing; about a minute for a six-week schedule.',
      technical:
        'Hybrid: simulated annealing over the whole period, with CP-SAT re-optimising the ' +
        'hardest windows. Needs the OR-Tools runner that ships with ShiftNurse.',
    },
    'sa-lns': {
      name: 'Fastest',
      summary: 'A good schedule in seconds, on any computer. Handy for trying ideas quickly.',
      technical:
        'Simulated annealing with large-neighbourhood search. Cannot prove how close to the best ' +
        'possible it is. Runs on every install.',
    },
    'cp-sat': {
      name: 'Exhaustive',
      summary:
        'Works the whole schedule as one puzzle and says how close to perfect it got. Slower on a ' +
        'unit this size, and can leave more gaps than the other two.',
      technical:
        'CP-SAT (Google OR-Tools) over the whole period, reporting its optimality gap. Needs the ' +
        'OR-Tools runner.',
    },
  };

/** The display order: the recommended default first. */
export const SOLVER_ORDER: readonly SolverId[] = ['hybrid', 'sa-lns', 'cp-sat'];
