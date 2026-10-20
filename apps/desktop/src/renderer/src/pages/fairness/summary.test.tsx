// @vitest-environment jsdom
/** The headline numbers are the report's own, over the nurses core could compare. */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  FAIRNESS_COMPONENTS,
  type FairnessComponent,
  type FairnessReport,
} from '@shiftnurse/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FairnessSummary } from './summary.js';

afterEach(cleanup);

describe('the fairness headline', () => {
  it('shows the headline the report computed', () => {
    // A fourth nurse who could not be compared scored 20; she is in `scores` but not in the
    // distribution, so she must not set the unit's "lowest".
    const flat = { gini: 0, min: 0, max: 0, mean: 0, spread: 0, count: 3 };
    const report = {
      scores: [{ nurseId: 'dee', score: 20, comparable: false }],
      weights: DEFAULT_FAIRNESS_WEIGHTS as Record<FairnessComponent, number>,
      distribution: {
        score: { count: 3, mean: 70, min: 55, max: 80, gini: 0.1, spread: 25 },
        components: Object.fromEntries(
          FAIRNESS_COMPONENTS.map((c) => [c, flat]),
        ) as FairnessReport['distribution']['components'],
      },
    } as unknown as FairnessReport;
    render(<FairnessSummary report={report} />);

    expect(screen.getByText('70')).toBeTruthy();
    expect(screen.getByText('55–80')).toBeTruthy();
    expect(screen.getByText('0.10')).toBeTruthy();
    expect(screen.queryByText('20')).toBeNull();
  });
});
