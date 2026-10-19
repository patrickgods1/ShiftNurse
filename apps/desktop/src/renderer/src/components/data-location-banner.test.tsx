// @vitest-environment jsdom
/**
 * The warning about a data folder on a network share: shown until dismissed, never on an
 * ordinary computer.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppInfo } from '../api.js';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import { DataLocationBanner } from './data-location-banner.js';

// The banner renders nothing for a null warning, so the test needs its own sign that the query
// has resolved; checking an empty DOM before then would pass for any banner.
function Settled() {
  return useAppInfo().isSuccess ? <span>info loaded</span> : null;
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const WARNING = 'Your ShiftNurse data is kept in a network folder (\\\\fs01\\a).';

describe('the data folder banner', () => {
  it('tells the manager their data is in a network folder until they dismiss it', async () => {
    bridge.respond('app', 'info', {
      version: '0.1.0',
      platform: 'win32',
      databasePath: 'x',
      dataLocationWarning: WARNING,
    } as never);
    renderWithApp(<DataLocationBanner />);

    expect(await screen.findByText(WARNING)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('shows nothing on an ordinary computer', async () => {
    bridge.respond('app', 'info', {
      version: '0.1.0',
      platform: 'win32',
      databasePath: 'x',
      dataLocationWarning: null,
    } as never);
    renderWithApp(
      <>
        <DataLocationBanner />
        <Settled />
      </>,
    );

    await screen.findByText('info loaded');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
