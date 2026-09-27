import { type Assignment, isoDate, type SolveInput } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { batchConcurrency, estimateBatch, inputFingerprint } from './solver-plan.js';

describe('how many variations run at once', () => {
  it('runs annealing variations side by side, keeping a core free for the app', () => {
    expect(batchConcurrency('sa-lns', 10, 8)).toBe(7);
    expect(batchConcurrency('sa-lns', 3, 8)).toBe(3);
  });

  it('runs one OR-Tools search at a time on an eight-core machine, since each uses eight threads', () => {
    expect(batchConcurrency('hybrid', 5, 8)).toBe(1);
    expect(batchConcurrency('cp-sat', 5, 8)).toBe(1);
    expect(batchConcurrency('hybrid', 5, 16)).toBe(2);
  });

  it('still runs something on a single-core machine', () => {
    expect(batchConcurrency('sa-lns', 4, 1)).toBe(1);
    expect(batchConcurrency('hybrid', 4, 2)).toBe(1);
  });
});

describe('how long a batch will take', () => {
  const base = {
    solver: 'sa-lns' as const,
    cores: 3,
    nurses: 42,
    days: 42,
    maxIterations: 200_000,
  };

  it('multiplies the last observed run by the rounds needed', () => {
    // 5 runs, 2 at a time → 3 rounds of 30 s.
    const estimate = estimateBatch({ ...base, count: 5, observedMs: 30_000 });
    expect(estimate).toEqual({
      perRunMs: 30_000,
      concurrency: 2,
      waves: 3,
      totalMs: 90_000,
      basis: 'observed',
    });
  });

  it('falls back to a rough figure before any run has finished', () => {
    // 42 × 42 = 1,764 nurse-days: 800 ms + 3.3 ms × 1,764 = 6,621 ms, close to the 6.6 s benched.
    const estimate = estimateBatch({ ...base, count: 1 });
    expect(estimate.basis).toBe('rough');
    expect(estimate.perRunMs).toBe(6621);
  });

  it('scales the rough figure with the iteration budget', () => {
    // Half the iterations: 800 + 3.3 × 1,764 / 2 = 3,710.6 ms.
    const estimate = estimateBatch({ ...base, count: 1, maxIterations: 100_000 });
    expect(estimate.perRunMs).toBe(3711);
  });

  it('prices a CP-SAT run at about a second per unit of its search budget', () => {
    const estimate = estimateBatch({ ...base, solver: 'cp-sat', count: 2, deterministicTime: 30 });
    expect(estimate.perRunMs).toBe(30_000);
    expect(estimate.totalMs).toBe(60_000);
  });
});

describe('whether saved candidates still match the inputs', () => {
  function input(assignments: Assignment[]): SolveInput {
    return {
      assignments,
      period: { id: 'p', startDate: isoDate('2026-01-04') },
    } as unknown as SolveInput;
  }
  const row = (id: string, isLocked: boolean, nurseId = 'n1'): Assignment => ({
    id,
    periodId: 'p',
    nurseId,
    shiftTypeId: 'day',
    date: isoDate('2026-01-05'),
    source: 'manual',
    isLocked,
    isCharge: false,
    isOvertime: false,
  });

  it('ignores hand edits to unlocked shifts, which Generate throws away anyway', () => {
    const before = inputFingerprint(input([row('a', true), row('b', false)]));
    const after = inputFingerprint(input([row('a', true), row('c', false, 'n2')]));
    expect(after).toBe(before);
  });

  it('notices a newly locked shift', () => {
    const before = inputFingerprint(input([row('a', true), row('b', false)]));
    const after = inputFingerprint(input([row('a', true), row('b', true)]));
    expect(after).not.toBe(before);
  });

  it('does not care which order the database returned locked shifts in', () => {
    const one = inputFingerprint(input([row('a', true, 'n1'), row('b', true, 'n2')]));
    const two = inputFingerprint(input([row('b', true, 'n2'), row('a', true, 'n1')]));
    expect(two).toBe(one);
  });

  it('notices any other change to what the solver reads', () => {
    const before = inputFingerprint(input([]));
    const changed = {
      ...input([]),
      timeOff: [{ id: 't', nurseId: 'n1' }],
    } as unknown as SolveInput;
    expect(inputFingerprint(changed)).not.toBe(before);
  });
});
