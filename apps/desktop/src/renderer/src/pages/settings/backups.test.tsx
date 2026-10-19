// @vitest-environment jsdom
/**
 * Settings › Backups: restore replaces the live database, so it asks inside a dialog the manager
 * cannot miss (not a block under a 14-row table), and one file's failure is not shown on the next.
 */

import type { BackupInfo } from '@shared/api.js';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import BackupsPanel from './backups.js';

const A: BackupInfo = {
  fileName: 'shiftnurse-daily-2026-10-17.db',
  path: '/b/shiftnurse-daily-2026-10-17.db',
  kind: 'daily',
  createdAt: Date.UTC(2026, 9, 17, 12),
  bytes: 4096,
};
const B: BackupInfo = {
  fileName: 'shiftnurse-manual-2026-10-16.db',
  path: '/b/shiftnurse-manual-2026-10-16.db',
  kind: 'manual',
  createdAt: Date.UTC(2026, 9, 16, 12),
  bytes: 8192,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('backups', 'list', [A, B]);
  bridge.respond('backups', 'listDeleted', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('Settings › Backups', () => {
  it('asks inside a dialog before restoring a backup, and restores the one named', async () => {
    renderWithApp(<BackupsPanel />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Restore' }))[0]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(A.fileName)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore and restart' }));
    await waitFor(() => expect(bridge.callsTo('backups', 'restore')).toEqual([[A.fileName]]));
  });

  it("does not show one backup's restore error in another's prompt", async () => {
    bridge.fail('backups', 'restore', new Error('The file is damaged'));
    renderWithApp(<BackupsPanel />);
    const restores = await screen.findAllByRole('button', { name: 'Restore' });
    fireEvent.click(restores[0]!);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restore and restart',
      }),
    );
    expect(await screen.findByText('The file is damaged')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(B.fileName)).toBeTruthy();
    expect(screen.queryByText('The file is damaged')).toBeNull();
  });

  it('keeps the restore prompt open while the restore is running', async () => {
    // A restore that never answers stands for the app relaunching under the prompt.
    bridge.respond('backups', 'restore', (() => new Promise(() => {})) as never);
    renderWithApp(<BackupsPanel />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Restore' }))[0]!);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore and restart' }));
    await waitFor(() => expect(bridge.callsTo('backups', 'restore')).toHaveLength(1));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {});
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('offers moving to Deleted backups as the main choice', async () => {
    renderWithApp(<BackupsPanel />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]!);
    const dialog = await screen.findByRole('alertdialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.at(-1)?.textContent).toBe('Move to Deleted backups');

    fireEvent.click(buttons.at(-1)!);
    await waitFor(() =>
      expect(bridge.callsTo('backups', 'remove')).toEqual([[A.fileName, { permanent: false }]]),
    );
  });

  it('names every column for a screen reader', async () => {
    renderWithApp(<BackupsPanel />);
    await screen.findAllByRole('button', { name: 'Restore' });
    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col');
    expect(headers.at(-1)?.textContent).toBe('Actions');
  });
});
