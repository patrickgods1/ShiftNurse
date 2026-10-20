// @vitest-environment jsdom
/**
 * The Export menu says once where the file went (and lets that go), and says once what went
 * wrong — a failure that also toasted would be two messages for one problem.
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { ExportMenu } from './export-menu.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  bridge.uninstall();
});

async function choose(label: string) {
  const open = await screen.findByTestId('export-open');
  fireEvent.keyDown(open, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByText(label));
}

describe('exporting a schedule', () => {
  it('shows a failed export once, beside the menu', async () => {
    bridge.fail('output', 'exportToFile', new Error('The folder is read-only.'));
    renderWithApp(<ExportMenu periodId="p-1" />);
    await choose('Grid (CSV)');
    await screen.findByRole('alert');
    expect(screen.getAllByText('The folder is read-only.').length).toBe(1);
  });

  it('lets the saved path go after a few seconds', async () => {
    // Auto-advancing fake clock: waitFor still polls, but the 8 s timer only moves when told.
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    bridge.respond('output', 'exportToFile', '/tmp/autumn.csv');
    renderWithApp(<ExportMenu periodId="p-1" />);
    await choose('Grid (CSV)');
    await screen.findByText('Saved /tmp/autumn.csv');
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByText('Saved /tmp/autumn.csv')).toBeNull();
  });
});
