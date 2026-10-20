import { describe, expect, it } from 'vitest';

import type { Violation } from '../rules/types.js';
import { DEFAULT_OBJECTIVE_WEIGHTS, type ObjectiveWeights } from '../solver/types.js';
import { scoreResolution } from './resolution-score.js';
import type { ResolutionImpact } from './types.js';

// A distinct weight per term, so a term charged at the wrong weight or sign moves the total by an
// amount no other term could account for.
const WEIGHTS: ObjectiveWeights = {
  ...DEFAULT_OBJECTIVE_WEIGHTS,
  hardShortfall: 1000,
  targetShortfall: 7,
  fairness: 3,
  cost: 0.5,
};

const IMPACT: ResolutionImpact = {
  // One slot closed in linear terms, but on a shift three short: the convex price falls by 3.
  coverage: { hardShortfallBefore: 3, hardShortfallAfter: 2, delta: -1 },
  shortfallPriceDelta: -3,
  targetShortfallDelta: -2,
  fairness: { unitScoreBefore: 80, unitScoreAfter: 82, delta: 2, affected: [] },
  // No rate on file: $0 on the books, $840 at the unit's dearest rate.
  cost: {
    dollarsBefore: 0,
    dollarsAfter: 0,
    delta: 0,
    unpriced: true,
    overtimeHoursDelta: 0,
    pessimisticDelta: 840,
  },
  softViolationsIntroduced: [{ severity: 'soft' } as Violation],
  softViolationsCleared: [],
};

describe('how an option is ranked', () => {
  it('weighs a deep shortfall, slots below target, fairness, the pessimistic cost and warnings', () => {
    //   1000 × 3     closing a slot on a shift three short (6 → 3)   = 3000
    // − 7 × (−2)     two slots brought up toward target              =  +14
    // + 3 × 2        two fairness points                             =   +6
    // − 0.5 × 840    the unpriced nurse at the dearest rate          = −420
    // − 7 × 1        one advisory warning raised                     =   −7
    //                                                                  2593
    expect(scoreResolution(IMPACT, WEIGHTS)).toBeCloseTo(2593, 9);
  });
});
