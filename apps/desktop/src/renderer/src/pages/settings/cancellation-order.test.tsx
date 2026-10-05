// @vitest-environment jsdom
/**
 * Settings › Requests › low-census cancellation order. A manager whose contract sends per diem
 * staff home before overtime reorders the tiers and saves; what crosses IPC is the whole order,
 * with any unticked tier left out.
 */

import { isoDate, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import CancellationOrderPanel from './cancellation-order.js';

const unit: Unit = {
  id: 'unit-1',
  name: '4 West',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('dayOf', 'cancellationPolicy', [
    'volunteer',
    'agency',
    'overtime',
    'per_diem',
    'rotation',
  ]);
  bridge.respond('dayOf', 'saveCancellationPolicy', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('Settings › the low-census cancellation order', () => {
  it('saves per diem ahead of overtime after the manager moves it up', async () => {
    renderWithApp(<CancellationOrderPanel />, { unit });
    fireEvent.click(await screen.findByLabelText('Move Per diem staff up'));
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'saveCancellationPolicy')).toEqual([
        ['unit-1', ['volunteer', 'agency', 'per_diem', 'overtime', 'rotation']],
      ]),
    );
  });

  it('leaves out a tier the manager unticks', async () => {
    renderWithApp(<CancellationOrderPanel />, { unit });
    fireEvent.click(await screen.findByLabelText(/^Agency and travel nurses/));
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'saveCancellationPolicy')).toEqual([
        ['unit-1', ['volunteer', 'overtime', 'per_diem', 'rotation']],
      ]),
    );
  });

  it('will not save an order with every tier removed', async () => {
    renderWithApp(<CancellationOrderPanel />, { unit });
    for (const label of [
      'Nurses who offer to go home',
      'Agency and travel nurses',
      'Staff on overtime for the shift',
      'Per diem staff',
      'The unit’s own staff, in rotation',
    ]) {
      fireEvent.click(await screen.findByLabelText(new RegExp(`^${label}`)));
    }
    expect((screen.getByRole('button', { name: 'Save order' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Keep at least one tier/)).toBeTruthy();
  });
});
