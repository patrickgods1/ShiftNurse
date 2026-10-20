// @vitest-environment jsdom
/**
 * Adding a year of holidays. The Year box is typed into digit by digit: `202` on the way to
 * `2028` is not a plan year, and a box that snapped back to 2027 made typing impossible.
 */

import { type HolidayYearPlan, isoDate } from '@shiftnurse/core';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { HolidayYearDialog } from './year-dialog.js';

const plan = (year: number): HolidayYearPlan => ({
  year,
  holidays: [
    {
      key: 'christmas',
      date: isoDate(`${year}-12-25`),
      name: 'Christmas Day',
      isMajor: true,
      pairWith: null,
      from: 'federal',
    },
    {
      key: 'eve',
      date: isoDate(`${year}-12-24`),
      name: 'Christmas Eve',
      isMajor: false,
      pairWith: { key: 'christmas' },
      from: 'federal',
    },
  ],
  repairs: [],
  skipped: [],
  unpaired: [],
});

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('holidays', 'planYear', (_unitId, year) => plan(year));
  bridge.respond('holidays', 'addYear', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const yearBox = () => screen.getByLabelText('Year') as HTMLInputElement;

function open(onClose = () => undefined) {
  return renderWithApp(
    <HolidayYearDialog unitId="u-1" holidays={[]} open defaultYear={2027} onClose={onClose} />,
  );
}

describe('Settings › Holidays › Add a year', () => {
  it('lets the manager type a year digit by digit', async () => {
    open();
    await screen.findByText('Add 2 holidays');

    fireEvent.change(yearBox(), { target: { value: '2' } });
    fireEvent.change(yearBox(), { target: { value: '20' } });
    fireEvent.change(yearBox(), { target: { value: '202' } });
    expect(yearBox().value).toBe('202');
    expect(screen.getByText('Enter a year from 1971 to 2200.')).toBeTruthy();

    fireEvent.change(yearBox(), { target: { value: '2028' } });
    expect(yearBox().value).toBe('2028');
    await waitFor(() => {
      const calls = bridge.callsTo('holidays', 'planYear');
      expect(calls[calls.length - 1]).toEqual(['u-1', 2028]);
    });
    expect(screen.queryByText('Enter a year from 1971 to 2200.')).toBeNull();
  });

  it('does not ask for a plan for an empty year', async () => {
    open();
    await screen.findByText('Add 2 holidays');
    fireEvent.change(yearBox(), { target: { value: '' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(yearBox().value).toBe('');
    expect(bridge.callsTo('holidays', 'planYear')).toEqual([['u-1', 2027]]);
    expect(screen.getByText('Enter a year from 1971 to 2200.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Add 2 holidays' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('will not add holidays for a year past 2200', async () => {
    open();
    await screen.findByText('Add 2 holidays');
    fireEvent.change(yearBox(), { target: { value: '2201' } });
    expect(screen.getByText('Enter a year from 1971 to 2200.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Add 2 holidays' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('adds the proposed year', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Add 2 holidays' }));
    await waitFor(() => expect(bridge.callsTo('holidays', 'addYear')).toHaveLength(1));
    expect(bridge.callsTo('holidays', 'addYear')[0]).toEqual([
      'u-1',
      {
        holidays: [
          {
            key: 'christmas',
            date: '2027-12-25',
            name: 'Christmas Day',
            isMajor: true,
            pairWith: null,
          },
          {
            key: 'eve',
            date: '2027-12-24',
            name: 'Christmas Eve',
            isMajor: false,
            pairWith: { key: 'christmas' },
          },
        ],
        repairs: [],
      },
    ]);
  });
});
