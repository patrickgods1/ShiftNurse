// @vitest-environment jsdom
/** The Fairness page: the unit's summary and the per-nurse table for the period picked. */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  FAIRNESS_COMPONENTS,
  type FairnessComponent,
  type FairnessReport,
  isoDate,
  type NurseFairnessScore,
  type SchedulePeriod,
  type Unit,
} from '@shiftnurse/core';
import { makeNurse, resetFixtureCounters } from '@shiftnurse/core/testing';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import FairnessPage from './fairness.js';

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;
const draft: SchedulePeriod = {
  id: 'p-oct',
  unitId: 'unit-1',
  name: 'p-oct',
  startDate: isoDate('2026-09-20'),
  endDate: isoDate('2026-10-03'),
  status: 'draft',
  ruleSetId: 'rs-1',
  ruleSetVersion: 1,
};

const score = (nurseId: string, value: number): NurseFairnessScore => ({
  nurseId,
  score: value,
  components: [],
  seniorityMultiplier: 1,
  burdenIndex: 0,
  comparable: true,
  occurrences: { nights: [], weekends: [], holidays: [] },
});

const slow = { timeout: 4000 };

let bridge: FakeBridge;
beforeEach(() => {
  resetFixtureCounters();
  bridge = installFakeBridge();
  bridge.respondDefault([]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the Fairness page', { timeout: 15000 }, () => {
  it('shows the unit summary and the per-nurse table for the picked period', async () => {
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Reyes', contractedHoursPerPeriod: 72 });
    const ben = makeNurse({ firstName: 'Ben', lastName: 'Cole', contractedHoursPerPeriod: 72 });
    const flat = { gini: 0, min: 0, max: 0, mean: 0, spread: 0, count: 2 };
    const components = Object.fromEntries(
      FAIRNESS_COMPONENTS.map((c) => [c, flat]),
    ) as FairnessReport['distribution']['components'];
    components.nights = { gini: 0.3, min: 0.2, max: 0.8, mean: 0.5, spread: 0.6, count: 2 };
    const report: FairnessReport = {
      scores: [score(ana.id, 80), score(ben.id, 60)],
      distribution: { score: flat, components },
      weights: DEFAULT_FAIRNESS_WEIGHTS as Record<FairnessComponent, number>,
    };
    bridge.respond('periods', 'list', [draft]);
    bridge.respond('nurses', 'list', [ana, ben]);
    bridge.respond('fairness', 'report', report);

    renderWithApp(<FairnessPage />, { unit });

    const summary = await screen.findByTestId('fairness-summary', {}, slow);
    // Mean of 80 and 60 is 70; the spread reads lowest to highest.
    expect(within(summary).getByText('70')).toBeTruthy();
    expect(within(summary).getByText('60–80')).toBeTruthy();
    // Gini of 80 and 60: (2 x 20) / (2 x 2^2 x 70) = 40 / 560 = 0.07 to two places.
    expect(within(summary).getByText('0.07')).toBeTruthy();
    // Nights is the only uneven burden, so it is the biggest gap.
    expect(within(summary).getByText('Night shifts')).toBeTruthy();

    const table = await screen.findByTestId('fairness-table');
    const rows = within(table).getAllByTestId('fairness-row');
    expect(rows.map((r) => within(r).getByRole('button').textContent)).toEqual([
      expect.stringContaining('Ben'),
      expect.stringContaining('Ana'),
    ]);
    await waitFor(() => expect(bridge.callsTo('fairness', 'report')).toEqual([['p-oct']]));
  });

  it('points the manager to the Schedule page when the unit has no periods yet', async () => {
    bridge.respond('periods', 'list', []);
    renderWithApp(<FairnessPage />, { unit });
    expect(
      await screen.findByText(
        'No scheduling periods yet. Create one on the Schedule page to score it.',
        {},
        slow,
      ),
    ).toBeTruthy();
  });
});
