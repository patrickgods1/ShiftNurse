/**
 * Distribution — how evenly the *whole unit* carries fairness burdens, one level up from a
 * single nurse's score. A manager staring at 30 individual scores can't eyeball whether the
 * unit as a whole is lopsided; the Gini coefficient and min/max spread answer that in one
 * number per component, and are what the Dashboard trends over time.
 */

import type {
  BurdenReport,
  DistributionStats,
  FairnessComponent,
  NurseFairnessScore,
  UnitDistribution,
} from './types.js';
import { BURDEN_COMPONENTS, BURDEN_COUNTER } from './types.js';

/**
 * Standard Gini coefficient over non-negative values: 0 = perfectly even, 1 = one value holds
 * everything. Uses the rank-sum form `G = (2*Σ(i·x_i)) / (n·Σx_i) − (n+1)/n` with values sorted
 * ascending and 1-indexed — equivalent to the area-between-Lorenz-curve-and-equality
 * definition, but doesn't require building the curve.
 */
export function gini(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0; // uniform (including all-zero) is perfectly even by definition
  const rankWeightedSum = sorted.reduce((sum, v, i) => sum + (i + 1) * v, 0);
  return (2 * rankWeightedSum) / (n * total) - (n + 1) / n;
}

export function distributionStats(values: readonly number[]): DistributionStats {
  const count = values.length;
  if (count === 0) {
    return { gini: 0, min: 0, max: 0, mean: 0, spread: 0, count: 0 };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, v) => sum + v, 0) / count;
  return { gini: gini(values), min, max, mean, spread: max - min, count };
}

export function unitDistribution(
  burden: BurdenReport,
  scores: readonly NurseFairnessScore[],
): UnitDistribution {
  const comparableIds = new Set(
    [...burden.byNurse.values()].filter((nb) => nb.shareWeight > 0).map((nb) => nb.nurseId),
  );

  const scoreValues = scores.filter((s) => comparableIds.has(s.nurseId)).map((s) => s.score);

  const components = {} as Record<FairnessComponent, DistributionStats>;

  // Burdens: a per-nurse *rate* (carried / shareWeight) among comparable nurses, so a 0.5 FTE
  // with half the nights of a full-timer reads as even rather than under-burdened.
  for (const component of BURDEN_COMPONENTS) {
    const counterKey = BURDEN_COUNTER[component];
    const rates: number[] = [];
    for (const nb of burden.byNurse.values()) {
      if (nb.shareWeight > 0) rates.push(nb.carried[counterKey] / nb.shareWeight);
    }
    components[component] = distributionStats(rates);
  }

  // Preferences: the hit rate over nurses with any record — history or the current period.
  const preferenceRates: number[] = [];
  for (const nb of burden.byNurse.values()) {
    if (nb.hasRows) preferenceRates.push(nb.carried.preferenceHitRate);
  }
  components.preferences = distributionStats(preferenceRates);

  // Time off: the approval rate over nurses who had at least one decision on record.
  const timeOffRates: number[] = [];
  for (const nb of burden.byNurse.values()) {
    const decisions = nb.carried.requestsApproved + nb.carried.requestsDenied;
    if (decisions > 0) timeOffRates.push(nb.carried.requestsApproved / decisions);
  }
  components.timeOff = distributionStats(timeOffRates);

  return {
    score: distributionStats(scoreValues),
    components,
  };
}
