// @vitest-environment jsdom
/**
 * Today is left open on the manager's second monitor through a morning handover. The header
 * clock and the Now/Next badges must move on without a click, so the page reads again on its own.
 */

import type { DayOfSummary } from '@shared/api.js';
import type { Unit } from '@shiftnurse/core';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import TodayPage from './today.js';

const at = (minuteOfDay: number) =>
  ({
    date: '2026-10-05',
    minuteOfDay,
    period: undefined,
    openCallOffs: [],
    shifts: [],
  }) as unknown as DayOfSummary;

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;

let bridge: FakeBridge;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Today left open', () => {
  it('reads Today again every minute while it stays open', async () => {
    // 6 * 60 + 58 = 418 is 06:58; 419 is 06:59.
    bridge.respond('dayOf', 'today', at(418));
    renderWithApp(<TodayPage />, { unit });
    expect(await screen.findByText(/as of 06:58/)).toBeTruthy();
    const before = bridge.callsTo('dayOf', 'today').length;

    bridge.respond('dayOf', 'today', at(419));
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(await screen.findByText(/as of 06:59/)).toBeTruthy();
    expect(bridge.callsTo('dayOf', 'today').length).toBe(before + 1);
  });

  it('keeps a half-written call-off reason when the page reads again behind the dialog', async () => {
    const withShift = (minuteOfDay: number) =>
      ({
        ...at(minuteOfDay),
        shifts: [
          {
            date: '2026-10-05',
            shiftType: { id: 'st-d', name: 'Day 12', abbreviation: 'D12', durationHours: 12 },
            status: 'other',
            staffing: { basis: 'floor', census: 0, short: false, ratioBreached: false, byRole: {} },
            overstaffed: [],
            period: { id: 'p-1', status: 'published' },
            roster: [
              {
                assignment: { id: 'a-ana', nurseId: 'n1' },
                nurse: {
                  id: 'n1',
                  firstName: 'Ana',
                  lastName: 'Martinez',
                  role: 'RN',
                  employmentType: 'per_diem',
                },
              },
            ],
          },
        ],
      }) as unknown as DayOfSummary;
    bridge.respond('dayOf', 'today', withShift(418));
    renderWithApp(<TodayPage />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Report call-off' }));
    const reason = await screen.findByRole('textbox');
    fireEvent.change(reason, { target: { value: 'Child is sick' } });

    // A fresh object, as a real refetch returns.
    bridge.respond('dayOf', 'today', withShift(419));
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(await screen.findByText(/as of 06:59/)).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Child is sick');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
