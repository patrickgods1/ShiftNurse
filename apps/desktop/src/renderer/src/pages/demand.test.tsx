// @vitest-environment jsdom
/** The Staffing needs page: the census grid for the dates picked. */

import { type CensusForecast, isoDate, type SchedulePeriod, type Unit } from '@shiftnurse/core';
import { DAY_12 } from '@shiftnurse/core/testing';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import DemandPage from './demand.js';

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;
const draft: SchedulePeriod = {
  id: 'p-sep',
  unitId: 'unit-1',
  name: 'p-sep',
  startDate: isoDate('2026-09-21'),
  endDate: isoDate('2026-09-22'),
  status: 'draft',
  ruleSetId: 'rs-1',
  ruleSetVersion: 1,
};

const census = (date: string, projectedCensus: number): CensusForecast => ({
  id: `c-${date}`,
  unitId: 'unit-1',
  date: isoDate(date),
  shiftTypeId: DAY_12.id,
  projectedCensus,
  acuityMix: {},
  source: 'manual',
});

const slow = { timeout: 4000 };

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('periods', 'list', [draft]);
  bridge.respond('shiftTypes', 'list', [DAY_12]);
  bridge.respond('census', 'list', [census('2026-09-21', 22), census('2026-09-22', 18)]);
  bridge.respond('census', 'hppd', {
    targetHours: undefined,
    nursingHours: 0,
    patientDays: 0,
    hppd: undefined,
    days: [],
    unmeasuredDates: [],
  });
  bridge.respond('census', 'backtest', {
    recorded: { samples: 0, meanAbsoluteError: 0, meanAbsolutePercentageError: 0, bias: 0 },
    model: { samples: 0, meanAbsoluteError: 0, meanAbsolutePercentageError: 0, bias: 0 },
    byShiftType: {},
  });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the Staffing needs page', { timeout: 15000 }, () => {
  it('shows the census grid for the picked dates', async () => {
    renderWithApp(<DemandPage />, { unit });

    await waitFor(
      () => expect(within(screen.getByTestId('census-grid')).getAllByRole('row')).toHaveLength(3),
      slow,
    );
    const grid = screen.getByTestId('census-grid');
    const rows = within(grid).getAllByRole('row').slice(1);
    // The period is Mon 21 – Tue 22 Sep 2026: one row each, with the day shift's census in it.
    expect(rows[0]!.textContent).toContain('Mon, Sep 21');
    expect(rows[0]!.textContent).toContain('22');
    expect(rows[1]!.textContent).toContain('Tue, Sep 22');
    expect(rows[1]!.textContent).toContain('18');
    expect(within(grid).getByRole('columnheader', { name: 'Day 12' })).toBeTruthy();
    expect(bridge.callsTo('census', 'list').at(-1)).toEqual([
      'unit-1',
      isoDate('2026-09-21'),
      isoDate('2026-09-22'),
    ]);
  });

  it('adds a row when the manager moves the end date out a day', async () => {
    renderWithApp(<DemandPage />, { unit });
    const end = await screen.findByLabelText('End date', {}, slow);
    await waitFor(() => expect((end as HTMLInputElement).value).toBe('2026-09-22'), slow);

    fireEvent.change(end, { target: { value: '2026-09-23' } });
    fireEvent.blur(end);

    await waitFor(() => {
      const grid = screen.getByTestId('census-grid');
      expect(within(grid).getAllByRole('row').slice(1)).toHaveLength(3);
    }, slow);
    expect(screen.getByText('Wed, Sep 23')).toBeTruthy();
  });

  it('explains a date range that cannot be shown and keeps the last good one on screen', async () => {
    renderWithApp(<DemandPage />, { unit });
    const end = await screen.findByLabelText('End date', {}, slow);
    await waitFor(() => expect((end as HTMLInputElement).value).toBe('2026-09-22'), slow);

    // Sep 21 to Jan 20 is 122 days, past the 120 the page will draw: a runaway range must not
    // become a thousand rows of editors.
    fireEvent.change(end, { target: { value: '2027-01-20' } });
    fireEvent.blur(end);

    const note = await screen.findByRole('alert', {}, slow);
    expect(note.textContent).toBe(
      'Show at most 120 days at a time; this range is 122 days. Showing Sep 21, 2026 to Sep 22, 2026 until it is fixed.',
    );
    expect(within(screen.getByTestId('census-grid')).getAllByRole('row').slice(1)).toHaveLength(2);
  });
});
