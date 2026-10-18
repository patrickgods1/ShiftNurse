// @vitest-environment jsdom
/** The period the manager picked on one page is the period every other page opens on. */

import { isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SelectedPeriodProvider, useSelectedPeriod } from './selected-period.js';

afterEach(cleanup);

function period(id: string, start: string, status: SchedulePeriod['status']): SchedulePeriod {
  const startDate = isoDate(start);
  return {
    id,
    unitId: 'unit-1',
    name: id,
    startDate,
    endDate: startDate,
    status,
    ruleSetId: 'rs',
    ruleSetVersion: 1,
  };
}

const SEP = period('sep', '2026-09-06', 'published');
const OCT = period('oct', '2026-10-04', 'draft');
const NOV = period('nov', '2026-11-01', 'draft');

function Consumer({
  name,
  periods,
  pick,
}: {
  name: string;
  periods: SchedulePeriod[];
  pick?: string;
}) {
  const { period: shown, select } = useSelectedPeriod(periods);
  return (
    <div>
      <span data-testid={name}>{shown?.id ?? 'none'}</span>
      {pick !== undefined ? (
        <button type="button" onClick={() => select(pick)}>
          pick {name}
        </button>
      ) : null}
    </div>
  );
}

describe('the period the manager is looking at', () => {
  it('opens on the most recent draft when the manager has not chosen', () => {
    render(
      <SelectedPeriodProvider>
        <Consumer name="a" periods={[SEP, OCT, NOV]} />
      </SelectedPeriodProvider>,
    );
    expect(screen.getByTestId('a').textContent).toBe('nov');
  });

  it('carries the manager’s choice to the next page', async () => {
    render(
      <SelectedPeriodProvider>
        <Consumer name="a" periods={[SEP, OCT, NOV]} pick="sep" />
        <Consumer name="b" periods={[SEP, OCT, NOV]} />
      </SelectedPeriodProvider>,
    );
    screen.getByText('pick a').click();
    await screen.findByText('sep', { selector: '[data-testid="b"]' });
  });

  it('stays on the period after it is published instead of jumping to another draft', () => {
    const tree = (periods: SchedulePeriod[]) => (
      <SelectedPeriodProvider>
        <Consumer name="a" periods={periods} />
      </SelectedPeriodProvider>
    );
    const { rerender } = render(tree([OCT, NOV]));
    expect(screen.getByTestId('a').textContent).toBe('nov');
    // Without the pin, Oct would now be the only draft and the default.
    rerender(tree([OCT, { ...NOV, status: 'published' }]));
    expect(screen.getByTestId('a').textContent).toBe('nov');
  });

  it('falls back to the default when the chosen period no longer exists', async () => {
    render(
      <SelectedPeriodProvider>
        <Consumer name="a" periods={[SEP, OCT]} pick="gone" />
      </SelectedPeriodProvider>,
    );
    screen.getByText('pick a').click();
    await screen.findByText('oct', { selector: '[data-testid="a"]' });
  });

  it('refuses to be used outside the provider', () => {
    expect(() => render(<Consumer name="a" periods={[]} />)).toThrow(
      'useSelectedPeriod must be used within SelectedPeriodProvider',
    );
  });
});
