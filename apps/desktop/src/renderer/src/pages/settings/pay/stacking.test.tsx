// @vitest-environment jsdom
/**
 * Settings › Pay › Premium stacking: compounding or additive premiums. A save replaces the whole
 * settings row, so the call-back minimum must travel with the choice or it would be reset to zero.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { StackingSection } from './stacking.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('cost', 'paySettings', {
    callBackMinimumHours: 2,
    premiumStacking: 'compound',
    holidayPayCoversOvertime: false,
  });
  bridge.respond('cost', 'savePaySettings', {
    callBackMinimumHours: 2,
    premiumStacking: 'additive',
    holidayPayCoversOvertime: false,
  });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('premium stacking in Settings › Pay', () => {
  it('shows the saved choice, with Save off until it changes', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    expect(((await screen.findByLabelText('Premium stacking')) as HTMLSelectElement).value).toBe(
      'compound',
    );
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches to additive and sends the call-back minimum along with it', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    fireEvent.change(await screen.findByLabelText('Premium stacking'), {
      target: { value: 'additive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        [
          'u-1',
          { callBackMinimumHours: 2, premiumStacking: 'additive', holidayPayCoversOvertime: false },
        ],
      ]),
    );
  });

  it('saves that holiday pay covers overtime, keeping the stacking and call-back as they were', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    fireEvent.click(
      await screen.findByLabelText(/Holiday pay covers overtime worked on the holiday/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        [
          'u-1',
          { callBackMinimumHours: 2, premiumStacking: 'compound', holidayPayCoversOvertime: true },
        ],
      ]),
    );
  });
});
