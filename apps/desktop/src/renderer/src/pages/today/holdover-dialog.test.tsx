// @vitest-environment jsdom
/**
 * Recording a holdover on Today: a nurse stayed past the end of the shift. Each click leads to
 * exactly the payload that would cross IPC, and a required holdover is not sent without a reason.
 */

import type { RosterEntryView, TodayShiftView } from '@shared/api.js';
import type { Assignment, Nurse, ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { HoldoverAction, holdoverLine } from './holdover-dialog.js';
import { ShiftCard } from './shift-card.js';

const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Cruz', role: 'RN' } as Nurse;
const shift = {
  date: '2026-10-05',
  shiftType: { id: 'st-d', name: 'Day', abbreviation: 'D12', isOnCall: false } as ShiftType,
} as TodayShiftView;
const plain = { assignment: { id: 'a-ana', periodId: 'p-1' }, nurse: ana } as RosterEntryView;
const held = {
  assignment: {
    id: 'a-ana',
    periodId: 'p-1',
    holdoverMinutes: 90,
    holdoverMandated: true,
  } as Assignment,
  nurse: ana,
} as RosterEntryView;

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('dayOf', 'recordHoldover', { id: 'a-ana', periodId: 'p-1' } as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const open = async (entry: RosterEntryView) => {
  renderWithApp(<HoldoverAction unitId="u-1" shift={shift} entry={entry} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Held over: Cruz' }));
};

describe('recording a holdover', () => {
  it('will not save a required holdover without a reason', async () => {
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Hours'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText('Required by the unit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save holdover' }));
    expect(await screen.findByText(/needs a reason/)).toBeTruthy();
    expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([]);
  });

  it('saves an hour and a half the nurse volunteered for as 90 minutes, no reason needed', async () => {
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Hours'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save holdover' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([
        [{ assignmentId: 'a-ana', minutes: 90, mandated: false }],
      ]),
    );
  });

  it('sends the reason when the unit required the nurse to stay', async () => {
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Minutes'), { target: { value: '45' } });
    fireEvent.click(screen.getByLabelText('Required by the unit'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'No relief arrived' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save holdover' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([
        [{ assignmentId: 'a-ana', minutes: 45, mandated: true, reason: 'No relief arrived' }],
      ]),
    );
  });

  it('starts from the recorded holdover and Clear sends zero minutes', async () => {
    await open(held);
    expect(((await screen.findByLabelText('Hours')) as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Minutes') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('Required by the unit') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([
        [{ assignmentId: 'a-ana', minutes: 0, mandated: false }],
      ]),
    );
  });

  it('shows the reason main gave when it refuses a draft shift', async () => {
    bridge.respond('dayOf', 'recordHoldover', () => {
      throw new Error('A holdover is recorded on a published shift; publish first');
    });
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Minutes'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save holdover' }));
    expect(await screen.findByText(/recorded on a published shift/)).toBeTruthy();
  });
});

describe('a length that cannot be right', () => {
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save holdover' }));

  it('refuses 13 hours, since a holdover tops out at 12', async () => {
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Hours'), { target: { value: '13' } });
    save();
    expect(await screen.findByText(/Enter a length/)).toBeTruthy();
    expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([]);
  });

  it('refuses a negative hour even when the minutes would make up for it', async () => {
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Hours'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '90' } });
    save();
    expect(await screen.findByText(/Enter a length/)).toBeTruthy();
    expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([]);
  });

  it('refuses empty hours and minutes', async () => {
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Hours'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '' } });
    save();
    expect(await screen.findByText(/Enter a length/)).toBeTruthy();
    expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([]);
  });

  it('takes 90 minutes typed with no hours as an hour and a half', async () => {
    await open(plain);
    fireEvent.change(await screen.findByLabelText('Hours'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '90' } });
    save();
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'recordHoldover')).toEqual([
        [{ assignmentId: 'a-ana', minutes: 90, mandated: false }],
      ]),
    );
  });
});

describe('the roster line', () => {
  it('says how long a nurse was held over and whether it was required', () => {
    expect(holdoverLine(held)).toBe('Held over 1h 30m · required');
    expect(holdoverLine(plain)).toBeUndefined();
  });
});

describe('the roster on a card', () => {
  const card = (periodStatus: 'draft' | 'published') =>
    renderWithApp(
      <ShiftCard
        unitId="u-1"
        periodId="p-1"
        periodStatus={periodStatus}
        shift={
          {
            ...shift,
            status: 'other',
            overstaffed: [],
            staffing: { basis: 'floor', byRole: {} },
            roster: [plain],
          } as unknown as TodayShiftView
        }
        onReport={() => {}}
      />,
    );

  it('offers Held over on a published shift', async () => {
    card('published');
    expect(await screen.findByRole('button', { name: 'Held over: Cruz' })).toBeTruthy();
  });

  it('offers no Held over on a draft schedule, where it would only be refused', async () => {
    card('draft');
    await screen.findByRole('button', { name: 'Report call-off' });
    expect(screen.queryByRole('button', { name: 'Held over: Cruz' })).toBeNull();
  });
});
