// @vitest-environment jsdom
/** The Schedule page's entry: which period it opens on, and what a unit with none is offered. */

import { isoDate, type SchedulePeriod, type Unit } from '@shiftnurse/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import SchedulePage from './schedule.js';

// The board is its own suite's business; here it only says which period it was handed.
vi.mock('./schedule/board.js', () => ({
  ScheduleBoard: ({ period, leading }: { period: SchedulePeriod; leading: React.ReactNode }) => (
    <div data-testid="board">
      {leading}
      <p>Board for {period.id}</p>
    </div>
  ),
}));

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;

function period(
  id: string,
  start: string,
  end: string,
  status: SchedulePeriod['status'],
): SchedulePeriod {
  return {
    id,
    unitId: 'unit-1',
    name: id,
    startDate: isoDate(start),
    endDate: isoDate(end),
    status,
    ruleSetId: 'rs-1',
    ruleSetVersion: 1,
  };
}

const slow = { timeout: 4000 };

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the Schedule page', { timeout: 15000 }, () => {
  it('opens on the current draft when the unit has one', async () => {
    // Autumn is published and starts later; Winter is the draft being built.
    bridge.respond('periods', 'list', [
      period('autumn', '2026-11-01', '2026-11-14', 'published'),
      period('winter', '2026-10-04', '2026-10-17', 'draft'),
    ]);
    renderWithApp(<SchedulePage />, { unit });

    expect(await screen.findByText('Board for winter', {}, slow)).toBeTruthy();
    const picker = screen.getByTestId('period-select') as HTMLSelectElement;
    expect(picker.value).toBe('winter');
    expect(picker.selectedOptions[0]!.textContent).toContain('— draft');
  });

  it('offers New period when the unit has no schedules yet', async () => {
    bridge.respond('periods', 'list', []);
    renderWithApp(<SchedulePage />, { unit });

    expect(
      await screen.findByText('No scheduling periods yet. Create one to start.', {}, slow),
    ).toBeTruthy();
    expect(screen.getByTestId('new-period').textContent).toBe('New period');
    expect(screen.queryByTestId('board')).toBeNull();
  });
});
