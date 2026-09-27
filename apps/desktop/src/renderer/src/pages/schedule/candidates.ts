/**
 * Which schedule a batch says to keep: its lowest-scoring variation, or the schedule already on
 * the grid when none of the variations beats it. Scores are compared as the manager reads them —
 * whole points — so a variation is never called better over a fraction nobody can see.
 */

import type { SolveBatchStatus, SolveRunStatus } from '@shared/api.js';

export type BestChoice =
  | { kind: 'variation'; index: number; score: number; gridScore?: number }
  /** `tie`: the grid scores the same as the best variation (often because it *is* that one). */
  | { kind: 'grid'; gridScore: number; bestVariation: number; bestScore: number; tie: boolean };

/** The number a manager sees: run `index` of a batch that continued after `offset` variations. */
export function variationNumber(batch: Pick<SolveBatchStatus, 'offset'>, index: number): number {
  return batch.offset + index + 1;
}

export function finishedRuns(batch: SolveBatchStatus): SolveRunStatus[] {
  return batch.stale ? [] : batch.runs.filter((r) => r.state === 'done');
}

export function bestChoice(batch: SolveBatchStatus): BestChoice | undefined {
  let best: SolveRunStatus | undefined;
  for (const run of finishedRuns(batch)) {
    if (!run.summary) continue;
    if (!best || run.summary.objective < best.summary!.objective) best = run;
  }
  if (!best) return undefined;
  const score = Math.round(best.summary!.objective);
  if (batch.draftObjective === undefined) return { kind: 'variation', index: best.index, score };
  const gridScore = Math.round(batch.draftObjective);
  if (gridScore <= score) {
    return {
      kind: 'grid',
      gridScore,
      bestVariation: best.index,
      bestScore: score,
      tie: gridScore === score,
    };
  }
  return { kind: 'variation', index: best.index, score, gridScore };
}
