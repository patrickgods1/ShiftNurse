import { describe, expect, it } from 'vitest';
import { chooseSolver, OR_TOOLS_MISSING, solverAvailability } from './solver-choice.js';

describe('choosing a solver for Generate', () => {
  it('marks CP-SAT and hybrid unavailable when the OR-Tools runner is missing', () => {
    expect(solverAvailability(false)).toEqual([
      { id: 'hybrid', available: false, reason: OR_TOOLS_MISSING },
      { id: 'sa-lns', available: true },
      { id: 'cp-sat', available: false, reason: OR_TOOLS_MISSING },
    ]);
  });

  it("runs the unit's saved solver when the manager does not override it", () => {
    const choice = chooseSolver(undefined, { solverId: 'cp-sat' }, solverAvailability(true));
    expect(choice).toEqual({ id: 'cp-sat' });
  });

  it("lets a one-off choice override the unit's saved solver", () => {
    const choice = chooseSolver('sa-lns', { solverId: 'hybrid' }, solverAvailability(true));
    expect(choice).toEqual({ id: 'sa-lns' });
  });

  it('falls back to annealing on a unit set to hybrid when the runner is missing', () => {
    const choice = chooseSolver(undefined, { solverId: 'hybrid' }, solverAvailability(false));
    expect(choice.id).toBe('sa-lns');
    expect(choice.fellBackFrom?.solver).toBe('hybrid');
  });
});
