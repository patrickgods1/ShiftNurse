// @vitest-environment jsdom
/**
 * The nav's "requests waiting" count: time off from the dashboard plus proposed exchanges.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import { RequestsBadge, requestsLabel, useWaitingRequestCount } from './requests-badge.js';

function NavItem() {
  const waiting = useWaitingRequestCount('unit-1');
  return (
    <a href="#/requests" aria-label={requestsLabel(waiting)}>
      Requests
      <RequestsBadge count={waiting} />
    </a>
  );
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the Requests nav badge', () => {
  it('counts two time-off requests and one exchange as three waiting', async () => {
    bridge.respond('dashboard', 'summary', { pendingTimeOff: 2 } as never);
    bridge.respond('exchange', 'list', [{ id: 'swap-1' }] as never);
    renderWithApp(<NavItem />);

    expect(
      await screen.findByRole('link', { name: 'Requests, 3 waiting for a decision' }),
    ).toBeTruthy();
    expect(screen.getByTestId('requests-badge').textContent).toBe('3');
  });

  it('shows no badge when nothing is waiting', async () => {
    bridge.respond('dashboard', 'summary', { pendingTimeOff: 0 } as never);
    bridge.respond('exchange', 'list', []);
    renderWithApp(<NavItem />);

    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(1));
    expect(screen.getByRole('link', { name: 'Requests' })).toBeTruthy();
    expect(screen.queryByTestId('requests-badge')).toBeNull();
  });
});
