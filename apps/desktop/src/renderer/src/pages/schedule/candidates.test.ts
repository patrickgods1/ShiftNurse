import type { SolveBatchStatus, SolveRunStatus } from '@shared/api.js';
import { describe, expect, it } from 'vitest';
import { bestChoice } from './candidates.js';

function run(index: number, objective: number | undefined): SolveRunStatus {
  return {
    index,
    seed: index,
    solver: 'sa-lns',
    state: objective === undefined ? 'failed' : 'done',
    ...(objective === undefined
      ? {}
      : {
          summary: {
            objective,
            floorsShort: 0,
            unfilledSlots: 0,
            hardViolations: 0,
            softViolations: 0,
            elapsedMs: 1,
          },
        }),
  };
}

function batch(objectives: (number | undefined)[], draftObjective?: number): SolveBatchStatus {
  return {
    id: 'b',
    periodId: 'p',
    solver: 'sa-lns',
    state: 'done',
    cancelled: false,
    count: objectives.length,
    offset: 0,
    concurrency: 1,
    startedAt: 0,
    runs: objectives.map((o, i) => run(i, o)),
    ...(draftObjective === undefined ? {} : { draftObjective }),
  };
}

describe('which schedule to keep', () => {
  it('picks the lowest-scoring variation when the grid is empty', () => {
    expect(bestChoice(batch([300, 100, 200]))).toEqual({ kind: 'variation', index: 1, score: 100 });
  });

  it('keeps the grid when it already scores better than every variation', () => {
    expect(bestChoice(batch([65_300, 65_100], 64_878))).toEqual({
      kind: 'grid',
      gridScore: 64_878,
      bestVariation: 1,
      bestScore: 65_100,
      tie: false,
    });
  });

  it('calls it a tie when the grid holds the best variation, float noise and all', () => {
    const choice = bestChoice(batch([62_904.2, 62_670.4], 62_670.40000000001));
    expect(choice).toMatchObject({ kind: 'grid', tie: true, bestVariation: 1 });
  });

  it('recommends a variation that beats the grid', () => {
    expect(bestChoice(batch([62_704, 62_670], 64_878))).toEqual({
      kind: 'variation',
      index: 1,
      score: 62_670,
      gridScore: 64_878,
    });
  });

  it('ignores variations that failed', () => {
    expect(bestChoice(batch([undefined, 500]))).toMatchObject({ kind: 'variation', index: 1 });
  });

  it('recommends nothing when no variation finished', () => {
    expect(bestChoice(batch([undefined, undefined]))).toBeUndefined();
  });
});
