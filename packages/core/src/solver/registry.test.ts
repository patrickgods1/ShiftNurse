import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOLVER_ID,
  FALLBACK_ORDER,
  PURE_SOLVERS,
  requiresOrTools,
  resolveSolverId,
  SOLVER_IDS,
} from './registry.js';

describe('solver registry', () => {
  it('defaults a unit to the hybrid solver', () => {
    expect(DEFAULT_SOLVER_ID).toBe('hybrid');
  });

  it('runs the solver the manager picked when it is installed', () => {
    const result = resolveSolverId('cp-sat', ['hybrid', 'sa-lns', 'cp-sat']);
    expect(result).toEqual({ id: 'cp-sat' });
  });

  it('falls back to annealing when OR-Tools is not installed, and says why', () => {
    const result = resolveSolverId('hybrid', ['sa-lns']);
    expect(result.id).toBe('sa-lns');
    expect(result.fellBackFrom?.solver).toBe('hybrid');
    expect(result.fellBackFrom?.reason).toMatch(/not available/i);
  });

  it('only SA + LNS runs without the OR-Tools runner', () => {
    expect(SOLVER_IDS.filter((id) => !requiresOrTools(id))).toEqual(['sa-lns']);
    expect(Object.keys(PURE_SOLVERS)).toEqual(['sa-lns']);
  });

  it('lists every solver exactly once in the fallback order', () => {
    expect([...FALLBACK_ORDER].sort()).toEqual([...SOLVER_IDS].sort());
  });

  it('refuses to resolve when nothing at all can run', () => {
    expect(() => resolveSolverId('hybrid', [])).toThrow(/no solver/i);
  });
});
