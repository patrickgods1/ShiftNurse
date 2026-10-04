import { describe, expect, it } from 'vitest';
import { solverSchemas } from './solver.js';

describe('a Generate request arriving over IPC', () => {
  const start = solverSchemas.start;

  it('accepts the options the smoke run and the dialog send', () => {
    expect(start.safeParse(['p-1', { maxIterations: 20000, count: 1 }]).success).toBe(true);
    expect(
      start.safeParse(['p-1', { count: 3, continueAfter: 'batch-1-9', solver: 'sa-lns' }]).success,
    ).toBe(true);
    expect(start.safeParse(['p-1']).success).toBe(true);
  });

  it('refuses a batch of eleven variations and a solver that does not exist', () => {
    expect(start.safeParse(['p-1', { count: 11 }]).success).toBe(false);
    expect(start.safeParse(['p-1', { solver: 'magic' }]).success).toBe(false);
    expect(start.safeParse(['p-1', { maxIterations: Number.NaN }]).success).toBe(false);
  });

  it('refuses an option the solver does not have', () => {
    expect(start.safeParse(['p-1', { threads: 64 }]).success).toBe(false);
  });
});
