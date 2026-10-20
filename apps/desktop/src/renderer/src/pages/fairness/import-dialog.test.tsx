// @vitest-environment jsdom
/** The history import says why a file failed and refuses a file with nothing to import. */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { ImportHistoryDialog } from './import-dialog.js';

let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('import history dialog', () => {
  it('says why the file could not be read', async () => {
    bridge.fail('fairness', 'pickHistoryImportFile', new Error('The file is not UTF-8'));
    renderWithApp(<ImportHistoryDialog open onOpenChange={() => {}} unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    expect(await screen.findByText('Could not read that file: The file is not UTF-8')).toBeTruthy();
  });

  it('will not import a file with no pay periods', async () => {
    bridge.respond('fairness', 'pickHistoryImportFile', {
      path: '/tmp/empty.csv',
      rows: [],
      errors: [],
      periods: [],
    });
    renderWithApp(<ImportHistoryDialog open onOpenChange={() => {}} unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    expect(await screen.findByText('No pay periods found in this file.')).toBeTruthy();
    const button = screen.getByRole('button', { name: /^Import/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
