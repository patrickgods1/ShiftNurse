// @vitest-environment jsdom
import type { SolveBatchStatus, SolveRunStatus } from '@shared/api.js';
import { isoDate, type ShiftType, type Unit } from '@shiftnurse/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CandidatesBar } from './candidates-bar.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('shiftTypes', 'list', [
    { id: 'st-night', name: 'Night 12' },
    { id: 'st-day', name: 'Day 12' },
  ] as ShiftType[]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const digest = {
  nights: { min: 0, max: 0 },
  weekends: { min: 0, max: 0 },
  quickFlips: 0,
  nursesUnderContract: 0,
  againstPreference: 0,
  onDaysAskedOff: 0,
};

function batchWith(summary: Partial<NonNullable<SolveRunStatus['summary']>>): SolveBatchStatus {
  return {
    id: 'b',
    periodId: 'p',
    solver: 'sa-lns',
    state: 'done',
    cancelled: false,
    count: 1,
    offset: 0,
    concurrency: 1,
    startedAt: 0,
    runs: [
      {
        index: 0,
        seed: 0,
        solver: 'sa-lns',
        state: 'done',
        summary: {
          objective: 100,
          digest,
          floorsShort: 0,
          unfilledSlots: 0,
          unfilled: [],
          hardViolations: 0,
          softViolations: 0,
          elapsedMs: 1,
          ...summary,
        },
      },
    ],
  };
}

function renderBar(batch: SolveBatchStatus) {
  return renderWithApp(
    <CandidatesBar
      batch={batch}
      selected={0}
      onSelect={() => {}}
      previewing={false}
      onTogglePreview={() => {}}
      onCompare={() => {}}
      onSave={() => {}}
      onDiscard={() => {}}
      onCancel={() => {}}
      onShowProgress={() => {}}
      saving={false}
      error={undefined}
    />,
    { unit: { id: 'unit-1' } as Unit },
  );
}

describe('an option that leaves shifts short', () => {
  it('says which shifts are short and which roles, in plain words', async () => {
    renderBar(
      batchWith({
        floorsShort: 4,
        unfilledSlots: 3,
        unfilled: [
          { date: isoDate('2026-10-10'), shiftTypeId: 'st-night', role: 'RN', shortfall: 1 },
          { date: isoDate('2026-10-10'), shiftTypeId: 'st-night', role: 'LPN', shortfall: 2 },
          { date: isoDate('2026-10-11'), shiftTypeId: 'st-day', role: 'RN', shortfall: 1 },
        ],
      }),
    );
    // Shift names arrive from their own query, a tick after the bar.
    await screen.findByText(/Night 12/);
    const list = screen.getByTestId('unfilled-list');
    const lines = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(lines).toEqual([
      'Sat, Oct 10, Night 12: short 1 RN, 2 LPN',
      'Sun, Oct 11, Day 12: short 1 RN',
    ]);
    expect(screen.getByText(/Requests › Conflicts ranks ways to cover them/)).toBeTruthy();
  });

  it('says how many more when the list is longer than a manager would read', async () => {
    const unfilled = Array.from({ length: 10 }, (_, i) => ({
      date: isoDate(`2026-10-${String(i + 1).padStart(2, '0')}`),
      shiftTypeId: 'st-night',
      role: 'RN' as const,
      shortfall: 1,
    }));
    renderBar(batchWith({ floorsShort: 10, unfilledSlots: 12, unfilled }));
    const list = await screen.findByTestId('unfilled-list');
    const lines = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(lines).toHaveLength(9);
    // 12 short in all, 8 shown: the two the status left out count too.
    expect(lines.at(-1)).toBe('and 4 more');
  });

  it('lists nothing when every shift is staffed', async () => {
    renderBar(batchWith({}));
    await screen.findByTestId('candidates-bar');
    expect(screen.queryByTestId('unfilled-list')).toBeNull();
  });
});
