// @vitest-environment jsdom
/**
 * Picking a state shows what applying it will do to the leave policy: a preset's policy goes in
 * whole and only into a unit that has none, so a manager who set one is told it stays.
 */

import { isoDate, type LeavePolicy, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import { StateLawSection } from './state-law.js';

const unit: Unit = {
  id: 'unit-1',
  name: '4A',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};
const ownPolicy: LeavePolicy = {
  fmla: { regime: 'title1', yearMethod: 'calendar' },
  leaveYearStart: 'calendar',
  accrual: [],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function chooseVa(u: Unit) {
  renderWithApp(<StateLawSection />, { unit: u });
  fireEvent.change(await screen.findByLabelText('State or federal law'), {
    target: { value: 'US-VA' },
  });
}

describe('the state-law preview', () => {
  it('says the VA preset sets the leave policy on a unit that has none', async () => {
    await chooseVa(unit);
    expect((await screen.findByTestId('state-law-leave')).textContent).toBe(
      'Sets the leave policy: Title 5 FMLA, federal leave year, 6 accrual rules.',
    );
  });

  it('says a unit’s own leave policy is left as it is', async () => {
    await chooseVa({ ...unit, leavePolicy: ownPolicy });
    expect((await screen.findByTestId('state-law-leave')).textContent).toBe(
      'Leaves your leave policy as it is.',
    );
  });
});

describe('the questions a preset asks before it applies', () => {
  it('asks California whether the unit runs a 12-hour alternative workweek', async () => {
    renderWithApp(<StateLawSection />, { unit });
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    expect(screen.getByTestId('state-law-option-alternativeWorkweek')).toBeTruthy();
    expect(screen.queryByTestId('state-law-option-compressedTour')).toBeNull();
  });

  it('asks Virginia whether nurses are on compressed tours', async () => {
    await chooseVa(unit);
    expect(screen.getByTestId('state-law-option-compressedTour')).toBeTruthy();
  });

  it('sends the manager’s answer when California is applied', async () => {
    bridge.respond('setup', 'applyJurisdiction', { created: 1, updated: 0, unchanged: 0 });
    renderWithApp(<StateLawSection />, { unit });
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    fireEvent.click(screen.getByTestId('state-law-option-alternativeWorkweek'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(/never loosens a setting you have/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(bridge.callsTo('setup', 'applyJurisdiction')).toEqual([
        ['unit-1', 'CA', { alternativeWorkweek: true }],
      ]),
    );
  });

  it('unticks the answer when the manager switches state and comes back', async () => {
    renderWithApp(<StateLawSection />, { unit });
    const select = await screen.findByLabelText('State or federal law');
    fireEvent.change(select, { target: { value: 'CA' } });
    fireEvent.click(screen.getByTestId('state-law-option-alternativeWorkweek'));
    fireEvent.change(select, { target: { value: 'US-VA' } });
    fireEvent.change(select, { target: { value: 'CA' } });
    expect(
      (screen.getByTestId('state-law-option-alternativeWorkweek') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('sends no answer when the box is left unticked', async () => {
    bridge.respond('setup', 'applyJurisdiction', { created: 1, updated: 0, unchanged: 0 });
    renderWithApp(<StateLawSection />, { unit });
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(/never loosens a setting you have/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(bridge.callsTo('setup', 'applyJurisdiction')).toEqual([['unit-1', 'CA', {}]]),
    );
  });
});
