// @vitest-environment jsdom
/**
 * The 05:40 path: the manager presses "Someone called off", types a few letters, picks the
 * nurse and confirms. The test follows it through to what would cross IPC.
 */

import type { DayOfSummary, RosterEntryView } from '@shared/api.js';
import type { CallOff, Nurse, ShiftType, Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import TodayPage from '../today.js';

const unit = { id: 'unit-1', name: '4 West' } as Unit;
const dayShift = {
  id: 'st-d',
  name: 'Day 12',
  abbreviation: 'D12',
  color: '#fff',
  durationHours: 12,
} as ShiftType;

function entry(id: string, first: string, last: string, callOff?: CallOff): RosterEntryView {
  return {
    assignment: { id: `a-${id}`, nurseId: id },
    nurse: {
      id,
      firstName: first,
      lastName: last,
      role: 'RN',
      employmentType: 'per_diem',
    } as Nurse,
    ...(callOff ? { callOff } : {}),
  } as RosterEntryView;
}

const summary = {
  date: '2026-10-05',
  minuteOfDay: 340,
  period: { id: 'p-1' },
  openCallOffs: [],
  shifts: [
    {
      date: '2026-10-05',
      shiftType: dayShift,
      status: 'current',
      staffing: { basis: 'floor', census: 0, short: false, ratioBreached: false, byRole: {} },
      roster: [
        entry('n1', 'Ana', 'Martinez'),
        entry('n2', 'Ben', 'Okafor', { id: 'co-1' } as CallOff),
        entry('n3', 'Maya', 'Lindqvist'),
      ],
    },
  ],
} as unknown as DayOfSummary;

const newCallOff = {
  callOff: { id: 'co-new', date: '2026-10-05', reportedAt: 0 },
  nurse: summary.shifts[0]!.roster[2]!.nurse,
  shiftType: dayShift,
  attempts: [],
} as unknown as DayOfSummary['openCallOffs'][number];

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('dayOf', 'today', summary);
  bridge.respond('dayOf', 'reportCallOff', { id: 'co-new' } as CallOff);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function openPicker() {
  renderWithApp(<TodayPage />, { unit });
  fireEvent.click(await screen.findByRole('button', { name: 'Someone called off' }));
  return within(await screen.findByTestId('call-off-picker'));
}

describe('reporting a call-off from the Today header', () => {
  it('lists who is on shift and marks the nurse who already called off', async () => {
    const picker = await openPicker();
    expect(picker.getByRole('button', { name: /Martinez, Ana/ })).toBeTruthy();
    const benRow = picker.getByRole('button', { name: /Okafor, Ben/ }) as HTMLButtonElement;
    expect(benRow.disabled).toBe(true);
    expect(benRow.textContent).toContain('Already called off');
  });

  it('narrows to the nurse as the first letters are typed', async () => {
    const picker = await openPicker();
    fireEvent.change(picker.getByLabelText('Search by name'), { target: { value: 'ma' } });
    expect(picker.getByRole('button', { name: /Martinez, Ana/ })).toBeTruthy();
    expect(picker.getByRole('button', { name: /Lindqvist, Maya/ })).toBeTruthy();
    expect(picker.queryByRole('button', { name: /Okafor/ })).toBeNull();
  });

  it('reports the chosen nurse after the confirmation dialog', async () => {
    const picker = await openPicker();
    fireEvent.click(picker.getByRole('button', { name: /Lindqvist, Maya/ }));
    const dialog = await screen.findByTestId('reason-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report call-off' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'reportCallOff')).toEqual([['a-n3', undefined, undefined]]),
    );
  });

  it('scrolls to and focuses the new call-off card once the refetch shows it', async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    const picker = await openPicker();
    fireEvent.click(picker.getByRole('button', { name: /Lindqvist, Maya/ }));
    const dialog = await screen.findByTestId('reason-dialog');
    bridge.respond('dayOf', 'today', {
      ...summary,
      openCallOffs: [newCallOff],
    } as unknown as DayOfSummary);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report call-off' }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-call-off-id')).toBe('co-new'),
    );
    expect(scrolled).toHaveBeenCalled();
  });

  it('does not take focus on a later refetch when the report never showed up', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const { queryClient } = renderWithApp(<TodayPage />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Someone called off' }));
    fireEvent.click(
      within(await screen.findByTestId('call-off-picker')).getByRole('button', {
        name: /Lindqvist, Maya/,
      }),
    );
    const dialog = await screen.findByTestId('reason-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report call-off' }));
    await waitFor(() => expect(bridge.callsTo('dayOf', 'reportCallOff')).toHaveLength(1));
    // The first read after the report is a new list without the card (e.g. cancelled elsewhere).
    bridge.respond('dayOf', 'today', { ...summary, openCallOffs: [] } as unknown as DayOfSummary);
    await queryClient.invalidateQueries();
    await new Promise((r) => setTimeout(r, 50));
    // Later, the card appears from an unrelated refetch.
    bridge.respond('dayOf', 'today', {
      ...summary,
      openCallOffs: [newCallOff],
    } as unknown as DayOfSummary);
    await queryClient.invalidateQueries();
    await screen.findByTestId('call-off-card');
    expect(document.activeElement?.getAttribute('data-call-off-id')).toBeNull();
  });
});
