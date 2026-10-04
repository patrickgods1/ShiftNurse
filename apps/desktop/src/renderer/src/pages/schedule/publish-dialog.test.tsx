// @vitest-environment jsdom
/**
 * Publishing carries a schedule to staff. A first publish needs nothing; a republish must say
 * why, because that reason is what staff are told.
 */

import type { PublishOutcome, PublishPreview } from '@shared/api.js';
import { isoDate, type SchedulePeriod, type ScheduleVersion } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { PublishDialog } from './publish-dialog.js';

const period: SchedulePeriod = {
  id: 'period-1',
  unitId: 'unit-1',
  name: 'October',
  startDate: isoDate('2026-10-04'),
  endDate: isoDate('2026-11-14'),
  status: 'draft',
  ruleSetId: 'rs-1',
  ruleSetVersion: 1,
};

const version1 = { id: 'v-1', periodId: 'period-1', version: 1 } as ScheduleVersion;

function preview(over: Partial<PublishPreview> = {}): PublishPreview {
  return {
    period,
    latestVersion: undefined,
    diff: { added: 12, removed: 0, changed: 0, changes: [], affectedNurseIds: ['n1', 'n2'] },
    pendingChanges: [],
    alerts: [],
    hardViolations: 0,
    softViolations: 0,
    nothingToPublish: false,
    ...over,
  };
}

const republishPreview = () =>
  preview({
    latestVersion: version1,
    diff: { added: 1, removed: 1, changed: 0, changes: [], affectedNurseIds: ['n1'] },
  });

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function renderDialog() {
  return renderWithApp(
    <PublishDialog
      open
      onOpenChange={() => {}}
      unitId="unit-1"
      period={period}
      nurses={[]}
      shiftTypes={[]}
    />,
  );
}

const confirm = async () => (await screen.findByTestId('publish-confirm')) as HTMLButtonElement;

describe('publishing a schedule', () => {
  it('publishes a first version with no reason asked for', async () => {
    bridge.respond('publish', 'preview', preview());
    renderDialog();
    const button = await confirm();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Publish');
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.callsTo('publish', 'publish')).toEqual([['period-1', undefined]]),
    );
  });

  it('sends an optional note on a first publish, trimmed', async () => {
    bridge.respond('publish', 'preview', preview());
    renderDialog();
    await confirm();
    fireEvent.change(screen.getByTestId('publish-reason'), { target: { value: ' Final ' } });
    fireEvent.click(await confirm());
    await waitFor(() =>
      expect(bridge.callsTo('publish', 'publish')).toEqual([['period-1', 'Final']]),
    );
  });

  it('asks why before republishing a schedule staff already have', async () => {
    bridge.respond('publish', 'preview', republishPreview());
    renderDialog();
    const button = await confirm();
    expect(button.textContent).toBe('Publish version 2');
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('publish-reason'), { target: { value: '   ' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('publish-reason'), {
      target: { value: ' Covered the sick call on the 12th ' },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.callsTo('publish', 'publish')).toEqual([
        ['period-1', 'Covered the sick call on the 12th'],
      ]),
    );
  });

  it('will not publish an unchanged schedule again', async () => {
    bridge.respond(
      'publish',
      'preview',
      preview({ latestVersion: version1, nothingToPublish: true }),
    );
    renderDialog();
    const button = await confirm();
    fireEvent.change(screen.getByTestId('publish-reason'), { target: { value: 'Why not' } });
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('publish-diff').textContent).toBe(
      'Nothing has changed since the last version.',
    );
  });

  it('holds publishing behind an acknowledgement while hard rules are broken', async () => {
    bridge.respond('publish', 'preview', preview({ hardViolations: 2 }));
    renderDialog();
    const button = await confirm();
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('publish-acknowledge'));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.callsTo('publish', 'publish')).toEqual([['period-1', undefined]]),
    );
  });

  it('shows the refusal when main will not publish', async () => {
    bridge.respond('publish', 'preview', republishPreview());
    bridge.fail('publish', 'publish', new Error('The schedule is unchanged since version 1.'));
    renderDialog();
    await confirm();
    fireEvent.change(screen.getByTestId('publish-reason'), { target: { value: 'Retry' } });
    fireEvent.click(await confirm());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The schedule is unchanged since version 1.');
  });

  it('tells the manager it is published and how many shifts went out', async () => {
    bridge.respond('publish', 'preview', preview());
    bridge.respond('publish', 'publish', {
      period: { ...period, status: 'published' },
      version: { ...version1 },
      diff: { added: 12, removed: 0, changed: 0, changes: [], affectedNurseIds: ['n1', 'n2'] },
      ledgerEntries: 2,
      backup: undefined,
    } as PublishOutcome);
    renderDialog();
    fireEvent.click(await confirm());
    await screen.findByText(/12 shifts for 2 nurses\./);
  });
});
