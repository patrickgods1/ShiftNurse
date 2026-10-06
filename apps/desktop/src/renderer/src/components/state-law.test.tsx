// @vitest-environment jsdom
/**
 * Picking a state shows what applying it will do to the leave policy: a preset's policy goes in
 * whole and only into a unit that has none, so a manager who set one is told it stays.
 */

import { isoDate, type LeavePolicy, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
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
