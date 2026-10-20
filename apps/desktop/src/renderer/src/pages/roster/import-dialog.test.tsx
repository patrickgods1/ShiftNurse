// @vitest-environment jsdom
/**
 * Roster › Import: the manager sees what the file would do before it does it — who comes back from
 * inactive, what gets cleared, which columns the file lacks — and what is previewed is what is sent.
 */

import { ROSTER_COLUMNS } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RosterImportPreview } from '../../../../shared/api.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { ImportDialog } from './import-dialog.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const rows = [{ nurse: {}, credentials: [] }] as unknown as RosterImportPreview['rows'];
const preview = (more: Partial<RosterImportPreview> = {}): RosterImportPreview => ({
  path: '/tmp/roster.csv',
  rows,
  errors: [],
  columns: [...ROSTER_COLUMNS],
  plan: [],
  ...more,
});
const summary = {
  created: 0,
  updated: 0,
  unchanged: 1,
  reactivated: [],
  keptInactive: [],
  credentialsCreated: [],
  credentialsGranted: 0,
  credentialsUpdated: 0,
};

async function pick(p: RosterImportPreview) {
  bridge.respond('roster', 'pickImportFile', p);
  bridge.respond('roster', 'importRows', summary);
  renderWithApp(<ImportDialog open onOpenChange={() => {}} unitId="unit-1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
  await screen.findByRole('heading', { name: 'Check the import' });
}

const cruz = {
  employeeId: 'E1',
  name: 'Cruz, Ana',
  action: 'unchanged' as const,
  inactive: true,
  changes: [],
};

describe('importing a roster file', () => {
  it('says why the file could not be read', async () => {
    bridge.fail('roster', 'pickImportFile', new Error('Permission denied: roster.csv'));
    renderWithApp(<ImportDialog open onOpenChange={() => {}} unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not read that file: Permission denied: roster.csv',
    );
  });

  it('asks before bringing back a nurse who left, and leaves her inactive by default', async () => {
    await pick(preview({ plan: [cruz] }));
    expect(
      screen.getByText('1 nurse in the file is inactive on this unit: Cruz, Ana.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 nurse' }));
    await waitFor(() => expect(bridge.callsTo('roster', 'importRows').length).toBe(1));
    expect(bridge.callsTo('roster', 'importRows')).toEqual([
      ['unit-1', rows, { columns: ROSTER_COLUMNS, reactivate: false }],
    ]);
  });

  it('brings her back when the manager ticks the box', async () => {
    await pick(preview({ plan: [cruz] }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Reactivate them, so Generate can schedule them again',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 nurse' }));
    await waitFor(() => expect(bridge.callsTo('roster', 'importRows').length).toBe(1));
    expect(bridge.callsTo('roster', 'importRows')[0]![2]).toEqual({
      columns: ROSTER_COLUMNS,
      reactivate: true,
    });
  });

  it('lists a schedule plan the import would clear', async () => {
    await pick(
      preview({
        plan: [
          {
            employeeId: 'E2',
            name: 'Lee, Bo',
            action: 'update',
            inactive: false,
            changes: [
              { field: 'Schedule plan', from: 'VA 72/80 (38 U.S.C. § 7456A)', to: undefined },
            ],
          },
        ],
      }),
    );
    expect(
      screen.getByText('1 nurse has a detail cleared because the cell is blank.', { exact: false }),
    ).toBeTruthy();
    expect(
      screen.getByText('Lee, Bo: Schedule plan VA 72/80 (38 U.S.C. § 7456A) → cleared'),
    ).toBeTruthy();
  });

  it('says which columns the file lacks are left alone', async () => {
    await pick(
      preview({
        columns: [
          'employee_id',
          'first_name',
          'last_name',
          'role',
          'employment_type',
          'fte',
          'seniority_date',
          'credentials',
        ],
      }),
    );
    const text = screen.getByText(/This file has no .* columns?;/).textContent ?? '';
    expect(text).toContain('contracted_hours_per_period');
    expect(text).toContain('schedule_kind');
    expect(text.endsWith('; those details are left as they are.')).toBe(true);
    expect(text).not.toContain('credentials');
  });

  it('will not import a file with no nurse rows', async () => {
    await pick(preview({ rows: [] }));
    expect(screen.getByText('The file has no nurse rows.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Import 0 nurses' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('labels the error column by spreadsheet row', async () => {
    await pick(
      preview({ errors: [{ line: 4, column: 'fte', message: 'FTE "abc" is not a number' }] }),
    );
    const table = screen.getByRole('table', { name: 'Rows with errors' });
    expect(within(table).getByRole('columnheader', { name: 'Row' })).toBeTruthy();
  });

  it('moves focus to the preview once the file is read', async () => {
    await pick(preview());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Check the import' }),
      ),
    );
  });

  it('moves focus to the result and names who came back', async () => {
    bridge.respond('roster', 'importRows', { ...summary, reactivated: ['Cruz, Ana'] });
    await pick(preview({ plan: [cruz] }));
    bridge.respond('roster', 'importRows', { ...summary, reactivated: ['Cruz, Ana'] });
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 nurse' }));
    const done = await screen.findByRole('heading', { name: 'Import complete.' });
    await waitFor(() => expect(document.activeElement).toBe(done));
    expect(screen.getByText('Reactivated: Cruz, Ana')).toBeTruthy();
    expect(screen.getByText('1 unchanged')).toBeTruthy();
  });

  it('says "1 row has errors" for one bad row and "2 rows have errors" for two', async () => {
    const e = (line: number): RosterImportPreview['errors'][number] => ({
      line,
      column: 'fte',
      message: 'FTE "abc" is not a number',
    });
    await pick(preview({ errors: [e(4)] }));
    expect(screen.getByText(/^1 row has errors/)).toBeTruthy();
    cleanup();
    await pick(preview({ errors: [e(4), e(5)] }));
    expect(screen.getByText(/^2 rows have errors/)).toBeTruthy();
  });

  it('names every nurse who is inactive, separated by semicolons', async () => {
    const reyes = { ...cruz, employeeId: 'E3', name: 'Reyes, Lu' };
    await pick(preview({ plan: [cruz, reyes] }));
    expect(
      screen.getByText('2 nurses in the file are inactive on this unit: Cruz, Ana; Reyes, Lu.'),
    ).toBeTruthy();
  });

  it('unticks the reactivate box when the manager picks another file', async () => {
    await pick(preview({ plan: [cruz] }));
    const box = () => screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(box());
    expect(box().checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a different file' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    await screen.findByRole('heading', { name: 'Check the import' });
    expect(box().checked).toBe(false);
  });
});
