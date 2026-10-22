// @vitest-environment jsdom
/**
 * Staffing needs › Staffing record (Title 22)…: the dates open on the latest published period, and
 * the click leads to exactly the payload that would cross IPC.
 */

import { isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { defaultRecordRange, StaffingRecordButton } from './staffing-record-dialog.js';

const period = (id: string, start: string, end: string, status: SchedulePeriod['status']) =>
  ({
    id,
    unitId: 'unit-1',
    name: id,
    startDate: isoDate(start),
    endDate: isoDate(end),
    status,
    ruleSetId: 'rs-1',
    ruleSetVersion: 1,
  }) satisfies SchedulePeriod;

const periods = [
  period('p-old', '2026-08-01', '2026-08-14', 'published'),
  period('p-new', '2026-08-15', '2026-08-28', 'published'),
  period('p-draft', '2026-08-29', '2026-09-11', 'draft'),
];

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('output', 'exportStaffingRecord', '/tmp/staffing-record.csv');
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function openDialog() {
  renderWithApp(<StaffingRecordButton unitId="unit-1" periods={periods} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Staffing record (Title 22)…' }));
  await screen.findByLabelText('From');
}

describe('the staffing record dialog', () => {
  it('opens on the most recent published period, not a later draft', () => {
    expect(defaultRecordRange(periods)).toEqual({
      start: isoDate('2026-08-15'),
      end: isoDate('2026-08-28'),
    });
  });

  it('exports a CSV for the dates chosen and says where it was saved', async () => {
    await openDialog();
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-08-15');
    fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-08-20' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'csv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() =>
      expect(bridge.callsTo('output', 'exportStaffingRecord')).toEqual([
        ['unit-1', '2026-08-15', '2026-08-20', 'csv'],
      ]),
    );
    expect((await screen.findByRole('status')).textContent).toBe(
      'Saved to /tmp/staffing-record.csv',
    );
  });

  it('will not export a range that ends before it starts', async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-08-01' } });
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('The last day is before the first.')).toBeTruthy();
  });

  it('says nothing was saved when the save dialog is cancelled', async () => {
    bridge.respond('output', 'exportStaffingRecord', undefined);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('status')).textContent).toBe('Cancelled: nothing was saved.');
  });
});
