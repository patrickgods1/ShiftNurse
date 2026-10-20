// @vitest-environment jsdom
/**
 * Settings › Holidays: adding one holiday and renaming another. The delete confirmation's wording
 * is deliberately not asserted here.
 */

import { type Holiday, isoDate, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import HolidaysPanel from './holidays.js';

const unit: Unit = {
  id: 'unit-1',
  name: '3 West ICU',
  unitType: 'ICU',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};

const christmas: Holiday = {
  id: 'h-1',
  unitId: 'unit-1',
  date: isoDate('2027-12-25'),
  name: 'Christmas',
  isMajor: true,
  pairedHolidayId: null,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('holidays', 'list', [christmas]);
  bridge.respond('rules', 'getLatest', { id: 'rs-1', unitId: 'unit-1', configs: [] } as never);
  bridge.respond('cost', 'differentials', []);
  bridge.respond('holidays', 'create', (input) => ({ ...input, id: 'h-2' }) as never);
  bridge.respond('holidays', 'update', (id, patch) => ({ ...christmas, id, ...patch }) as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('Settings › Holidays', () => {
  it('adds a holiday with a name and date', async () => {
    renderWithApp(<HolidaysPanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2027-07-04' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Independence Day ' } });
    fireEvent.click(screen.getByLabelText('Major holiday'));
    fireEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    await waitFor(() => expect(bridge.callsTo('holidays', 'create')).toHaveLength(1));
    expect(bridge.callsTo('holidays', 'create')[0]).toEqual([
      {
        unitId: 'unit-1',
        date: '2027-07-04',
        name: 'Independence Day',
        isMajor: true,
        pairedHolidayId: null,
      },
    ]);
  });

  it('renames a holiday', async () => {
    renderWithApp(<HolidaysPanel />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('New name for Christmas'), {
      target: { value: 'Christmas Day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('holidays', 'update')).toHaveLength(1));
    expect(bridge.callsTo('holidays', 'update')[0]).toEqual(['h-1', { name: 'Christmas Day' }]);
  });
});
