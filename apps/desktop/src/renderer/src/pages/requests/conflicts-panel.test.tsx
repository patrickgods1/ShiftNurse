// @vitest-environment jsdom
/**
 * The Requests conflicts panel. What a wrong field would silently break: the apply button must
 * send the option's id (main re-derives the option, so a payload would be refused by the schema),
 * and auto-resolve stopping part-way must say which fix it stopped at, not just show an error.
 */

import {
  type ConflictReport,
  isoDate,
  type Resolution,
  type SchedulePeriod,
} from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { ConflictsPanel } from './conflicts-panel.js';

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

function resolution(id: string, title: string): Resolution {
  return {
    id,
    conflictId: 'c-1',
    kind: 'assign_available',
    title,
    description: 'She is rested.',
    actions: [],
    impact: {
      coverage: { hardShortfallBefore: 1, hardShortfallAfter: 0, delta: -1 },
      fairness: { unitScoreBefore: 80, unitScoreAfter: 80, delta: 0, affected: [] },
      cost: { dollarsBefore: 0, dollarsAfter: 0, delta: 0, unpriced: false },
      softViolationsIntroduced: [],
      softViolationsCleared: [],
    },
    score: 1,
    nurseIds: [],
  };
}

const r1 = resolution('res-1', 'Assign Priya Nair');
const r2 = resolution('res-2', 'Assign Ada Park');

const report = {
  conflicts: [
    {
      id: 'c-1',
      kind: 'understaffing',
      severity: 'hard',
      dates: [isoDate('2026-10-09')],
      shiftTypeId: 's-1',
      message: 'Short by one RN',
    },
  ],
  resolutions: [r1],
  summary: { hard: 1, soft: 0, byKind: {}, hardShortfall: 1 },
} as unknown as ConflictReport;

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function renderPanel() {
  return renderWithApp(
    <ConflictsPanel
      unitId="unit-1"
      period={period}
      report={report}
      policy={{ enabled: true, maxCostDelta: 100, maxFairnessDrop: 5 }}
      nursesById={new Map()}
    />,
  );
}

describe('resolving a conflict from the Requests page', () => {
  it('sends the chosen option’s id with the reason, not the option itself', async () => {
    bridge.respond('conflicts', 'resolve', r1);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Covers it' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' }).at(-1)!);
    await waitFor(() =>
      expect(bridge.callsTo('conflicts', 'resolve')).toEqual([['period-1', 'res-1', 'Covers it']]),
    );
  });

  it('says which fix auto-resolve stopped at, and that the earlier ones went through', async () => {
    bridge.respond('conflicts', 'autoResolve', {
      applied: [r1],
      report,
      stoppedAt: { resolution: r2, message: 'That nurse already has that shift on that day.' },
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId('auto-resolve'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      `Applied 1, then stopped at “${r2.title}”: That nurse already has that shift on that day.`,
    );
  });

  it('says auto-resolve stopped at the first fix when nothing had been applied', async () => {
    bridge.respond('conflicts', 'autoResolve', {
      applied: [],
      report,
      stoppedAt: { resolution: r2, message: 'That nurse already has that shift on that day.' },
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId('auto-resolve'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      `Stopped at “${r2.title}”: That nurse already has that shift on that day.`,
    );
    expect(alert.textContent).not.toContain('Applied');
  });

  it('explains why a published period’s resolutions cannot be applied here', async () => {
    renderWithApp(
      <ConflictsPanel
        unitId="unit-1"
        period={{ ...period, status: 'published' }}
        report={report}
        policy={undefined}
        nursesById={new Map()}
      />,
    );
    const apply = await screen.findByRole('button', { name: 'Apply' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Resolutions change a draft only\./)).toBeTruthy();
  });

  it('shows a resolution that closes a gap as fewer slots short, not as a negative', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'Apply' });
    expect(screen.getByText('1 fewer slot short')).toBeTruthy();
    expect(screen.queryByText(/-1/)).toBeNull();
  });
});
