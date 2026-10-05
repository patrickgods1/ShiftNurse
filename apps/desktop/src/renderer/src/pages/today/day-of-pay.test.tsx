// @vitest-environment jsdom
/**
 * Pay events on the Today screen: a missed break per nurse, a call-back for a standby nurse, and
 * the hours a nurse sent home actually worked filled in afterwards. Each click leads to exactly
 * the payload that would cross IPC.
 */

import type { DayOfPayRecord, RosterEntryView, TodayShiftView } from '@shared/api.js';
import type { Nurse, ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NursePayActions, ShiftPayEvents } from './day-of-pay.js';

const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Cruz', role: 'RN' } as Nurse;
const bea = { id: 'n-bea', firstName: 'Bea', lastName: 'Diaz', role: 'RN' } as Nurse;
const entry = {
  assignment: { id: 'a-ana' },
  nurse: ana,
} as RosterEntryView;
const dayShift = {
  date: '2026-10-05',
  shiftType: { id: 'st-d', isOnCall: false, durationHours: 12 } as ShiftType,
} as TodayShiftView;
const standby = {
  date: '2026-10-05',
  shiftType: { id: 'st-oc', isOnCall: true, durationHours: 12 } as ShiftType,
} as TodayShiftView;

const sentHome: DayOfPayRecord = {
  id: 'dpe-1',
  unitId: 'u-1',
  nurseId: 'n-bea',
  kind: 'sent_home',
  date: '2026-10-05' as DayOfPayRecord['date'],
  shiftTypeId: 'st-d',
  scheduledHours: 12,
  hoursWorked: 0,
  note: 'Low-census cancellation',
  enteredBy: 'manager',
  createdAt: 0,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('dayOfPay', 'list', [sentHome]);
  bridge.respond('dayOfPay', 'record', sentHome);
  bridge.respond('dayOfPay', 'update', sentHome);
  bridge.respond('dayOfPay', 'remove', undefined);
  bridge.respond('nurses', 'list', [ana, bea]);
  bridge.respond('nurseUnits', 'floatingIn', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('recording what happened on a shift', () => {
  it('records a missed meal break for the nurse on that shift and day', async () => {
    renderWithApp(<NursePayActions unitId="u-1" shift={dayShift} entry={entry} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Missed break for Cruz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Missed meal break for Cruz' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOfPay', 'record')).toEqual([
        [
          {
            kind: 'missed_break',
            unitId: 'u-1',
            nurseId: 'n-ana',
            date: '2026-10-05',
            shiftTypeId: 'st-d',
            break: 'meal',
          },
        ],
      ]),
    );
  });

  it('offers a call-back only on a standby shift, and records the hours worked', async () => {
    const { unmount } = renderWithApp(
      <NursePayActions unitId="u-1" shift={dayShift} entry={entry} />,
    );
    expect(screen.queryByRole('button', { name: /Called back/ })).toBeNull();
    unmount();

    renderWithApp(<NursePayActions unitId="u-1" shift={standby} entry={entry} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Called back: Cruz' }));
    fireEvent.change(screen.getByLabelText('Hours Cruz worked after the call-back'), {
      target: { value: '2.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record call-back for Cruz' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOfPay', 'record')).toEqual([
        [
          {
            kind: 'call_back',
            unitId: 'u-1',
            nurseId: 'n-ana',
            date: '2026-10-05',
            shiftTypeId: 'st-oc',
            hoursWorked: 2.5,
          },
        ],
      ]),
    );
  });

  it('shows a refusal in words, such as a break already recorded', async () => {
    bridge.fail(
      'dayOfPay',
      'record',
      new Error('A missed meal break is already recorded for Ana Cruz that day'),
    );
    renderWithApp(<NursePayActions unitId="u-1" shift={dayShift} entry={entry} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Missed break for Cruz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Missed meal break for Cruz' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already recorded');
  });
});

describe('a nurse sent home for low census', () => {
  it('lists them on the shift with what they are owed for, and takes their real hours later', async () => {
    renderWithApp(<ShiftPayEvents unitId="u-1" shift={dayShift} />);
    expect(await screen.findByText(/Bea Diaz: Sent home from a 12h shift after 0h/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hours Bea Diaz worked'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save hours for Bea Diaz' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOfPay', 'update')).toEqual([['dpe-1', { hoursWorked: 1.5 }]]),
    );
  });

  it('removes a mistaken event', async () => {
    renderWithApp(<ShiftPayEvents unitId="u-1" shift={dayShift} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: /^Remove sent home from a 12h shift after 0h for Bea Diaz/,
      }),
    );
    await waitFor(() => expect(bridge.callsTo('dayOfPay', 'remove')).toEqual([['dpe-1']]));
  });

  it('says nothing when the shift has no pay events', async () => {
    bridge.respond('dayOfPay', 'list', []);
    renderWithApp(<ShiftPayEvents unitId="u-1" shift={dayShift} />);
    await waitFor(() => expect(bridge.callsTo('dayOfPay', 'list')).toHaveLength(1));
    expect(screen.queryByTestId('shift-pay-events')).toBeNull();
  });
});
