// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQueryClient } from '../query-client.js';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { UpdateBanner } from './update-banner.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function show() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <UpdateBanner />
    </QueryClientProvider>,
  );
}

const release = { version: '0.3.0', url: 'https://github.com/x/releases/tag/v0.3.0' };

describe('the update banner', () => {
  it('offers the download when a newer release is out', async () => {
    bridge.respond('app', 'update', release);
    show();
    expect((await screen.findByRole('status')).textContent).toContain(
      'ShiftNurse 0.3.0 is available.',
    );
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(release.url);
  });

  it('Not now hides it', async () => {
    bridge.respond('app', 'update', release);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing when there is no newer release', async () => {
    bridge.respond('app', 'update', null);
    show();
    await waitFor(() => expect(bridge.callsTo('app', 'update')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('output')).toBeNull();
  });
});
