// @vitest-environment jsdom
/**
 * Roster › nurse drawer › Export record…: the manager picks the dates and the format, and the
 * click leads to exactly the payload that would cross IPC. A cancelled save dialog is said, not
 * shown as success; a refusal from main reads as written.
 */

import type { Nurse } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { ExportRecordButton } from './nurse-record.js';

const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Cruz' } as Nurse;

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('nurseRecord', 'exportToFile', '/tmp/Cruz-Ana-record.pdf');
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function openDialog() {
  renderWithApp(<ExportRecordButton nurse={ana} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Export record…' }));
  await screen.findByLabelText('From');
}

describe('exporting a nurse’s record', () => {
  it('says up front that kept-apart groups are left out', async () => {
    await openDialog();
    expect(
      screen.getByText('Kept-apart groups and the reasons recorded for them are never included.'),
    ).toBeTruthy();
  });

  it('exports a CSV for the dates chosen and says where it was saved', async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-03-31' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'csv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() =>
      expect(bridge.callsTo('nurseRecord', 'exportToFile')).toEqual([
        ['n-ana', '2026-01-01', '2026-03-31', 'csv'],
      ]),
    );
    expect((await screen.findByRole('status')).textContent).toBe(
      'Saved to /tmp/Cruz-Ana-record.pdf',
    );
  });

  it('will not export a range that ends before it starts', async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-04-01' } });
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('The last day is before the first.')).toBeTruthy();
  });

  it('says nothing was saved when the save dialog is cancelled', async () => {
    bridge.respond('nurseRecord', 'exportToFile', undefined);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('status')).textContent).toBe('Cancelled: nothing was saved.');
  });

  it('shows a refusal from main in words', async () => {
    bridge.fail('nurseRecord', 'exportToFile', new Error('That nurse is not on the roster'));
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That nurse is not on the roster');
  });
});
