// @vitest-environment jsdom
/**
 * Settings › Pay › Call-back: the contract's minimum hours a call-back pays. The click leads to
 * exactly the payload that would cross IPC, and a figure a day cannot hold is not sent.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { CallBackSection } from './call-back.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('cost', 'paySettings', { callBackMinimumHours: 2, premiumStacking: 'additive' });
  bridge.respond('cost', 'savePaySettings', {
    callBackMinimumHours: 4,
    premiumStacking: 'additive',
  });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the call-back minimum in Settings › Pay', () => {
  it('shows the saved minimum and what it does, with Save off until it changes', async () => {
    renderWithApp(<CallBackSection unitId="u-1" />);
    expect(
      ((await screen.findByLabelText('Call-back minimum hours')) as HTMLInputElement).value,
    ).toBe('2');
    expect(
      screen.getByText('The fewest hours a call-back pays. 0 pays the hours worked.'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves a four-hour minimum', async () => {
    renderWithApp(<CallBackSection unitId="u-1" />);
    fireEvent.change(await screen.findByLabelText('Call-back minimum hours'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        ['u-1', { callBackMinimumHours: 4, premiumStacking: 'additive' }],
      ]),
    );
  });

  it('will not save a minimum longer than a day', async () => {
    renderWithApp(<CallBackSection unitId="u-1" />);
    fireEvent.change(await screen.findByLabelText('Call-back minimum hours'), {
      target: { value: '30' },
    });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Enter a number of hours from 0 to 24.')).toBeTruthy();
  });
});
