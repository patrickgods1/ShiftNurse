/**
 * Which schedule a batch says to keep: its lowest-scoring variation, or the schedule already on
 * the grid when none of the variations beats it. Scores are compared as the manager reads them —
 * whole points — so a variation is never called better over a fraction nobody can see.
 */

import type { SolveBatchStatus, SolveRunStatus, SolveRunSummary } from '@shared/api.js';
import type { CountRange } from '@shiftnurse/core';
import { formatDollars } from '../../money.js';

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

/** "2–9", or "3" when the fewest and the most are the same. */
export function spread(range: CountRange): string {
  return range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A variation as the phrases a manager weighs, most urgent first: gaps and rule breaks, then
 * how nights and weekends spread, quick flips from nights to days, short hours and cost. The
 * solver's score stays out of it — it is the solver's number, not the manager's.
 */
export function digestLine(
  summary: Pick<SolveRunSummary, 'floorsShort' | 'hardViolations' | 'digest' | 'costTotal'>,
): string[] {
  const { digest } = summary;
  const parts: string[] = [];
  parts.push(
    summary.floorsShort === 0 ? 'Every shift staffed' : plural(summary.floorsShort, 'short shift'),
  );
  if (summary.hardViolations > 0)
    parts.push(`${plural(summary.hardViolations, 'rule break')} to fix`);
  parts.push(`nights ${spread(digest.nights)} per nurse`, `weekends ${spread(digest.weekends)}`);
  parts.push(
    digest.quickFlips === 0
      ? 'no quick night-to-day flips'
      : `${plural(digest.quickFlips, 'quick night-to-day flip')}`,
  );
  if (digest.onDaysAskedOff > 0) {
    parts.push(`${plural(digest.onDaysAskedOff, 'shift')} on days asked off`);
  }
  if (digest.againstPreference > 0) {
    parts.push(`${plural(digest.againstPreference, 'shift')} against preferences`);
  }
  if (digest.nursesUnderContract > 0) {
    parts.push(`${plural(digest.nursesUnderContract, 'nurse')} under contract`);
  }
  if (summary.costTotal !== undefined) parts.push(formatDollars(summary.costTotal));
  return parts;
}
