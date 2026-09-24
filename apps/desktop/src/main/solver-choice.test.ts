import type { SolverId } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import {
  chooseSolver,
  NOT_IN_THIS_BUILD,
  OR_TOOLS_MISSING,
  solverAvailability,
} from './solver-choice.js';

const ALL_BUILT: ReadonlySet<SolverId> = new Set<SolverId>(['hybrid', 'cp-sat']);

describe('choosing a solver for Generate', () => {
  it('marks CP-SAT and hybrid unavailable when the OR-Tools runner is missing', () => {
    expect(solverAvailability(false, ALL_BUILT)).toEqual([
      { id: 'hybrid', available: false, reason: OR_TOOLS_MISSING },
      { id: 'sa-lns', available: true },
      { id: 'cp-sat', available: false, reason: OR_TOOLS_MISSING },
    ]);
  });

  it('does not offer a backend this build does not include, even with the runner installed', () => {
    const availability = solverAvailability(true, new Set<SolverId>(['cp-sat']));
    expect(availability.find((a) => a.id === 'hybrid')).toEqual({
      id: 'hybrid',
      available: false,
      reason: NOT_IN_THIS_BUILD,
    });
    expect(availability.find((a) => a.id === 'cp-sat')?.available).toBe(true);
  });

  it("runs the unit's saved solver when the manager does not override it", () => {
    const choice = chooseSolver(
      undefined,
      { solverId: 'cp-sat' },
      solverAvailability(true, ALL_BUILT),
    );
    expect(choice).toEqual({ id: 'cp-sat' });
  });

  it("lets a one-off choice override the unit's saved solver", () => {
    const choice = chooseSolver(
      'sa-lns',
      { solverId: 'hybrid' },
      solverAvailability(true, ALL_BUILT),
    );
    expect(choice).toEqual({ id: 'sa-lns' });
  });

  it('falls back to annealing on a unit set to hybrid when the runner is missing', () => {
    const choice = chooseSolver(
      undefined,
      { solverId: 'hybrid' },
      solverAvailability(false, ALL_BUILT),
    );
    expect(choice.id).toBe('sa-lns');
    expect(choice.fellBackFrom?.solver).toBe('hybrid');
  });
});
