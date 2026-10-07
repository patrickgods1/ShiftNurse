// @vitest-environment jsdom
/**
 * The manager has to send a nurse to 4B Telemetry. The panel ranks who floats by the contract's
 * order and floats only the first, with the unit named. Each test follows a click to what would
 * cross IPC.
 */

import type { FloatOrderView, TodayShiftView } from '@shared/api.js';
import type { ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { FloatOut } from './float-out.js';

const shift = {
  date: '2026-10-05',
  shiftType: { id: 'st-d', abbreviation: 'D12' } as ShiftType,
} as TodayShiftView;

const ada = {
  nurseId: 'n-ada',
  assignmentId: 'a-ada',
  name: 'Ada Nurse',
  rank: 1,
  basis: 'rotation' as const,
  reason: 'Rotation: not floated in the last year; most junior',
};
const bea = {
  nurseId: 'n-bea',
  assignmentId: 'a-bea',
  name: 'Bea Nurse',
  rank: 2,
  basis: 'rotation' as const,
  reason: 'Rotation: floated 1 time in the last year, last on Wed Apr 1',
};

const view = (volunteer?: string): FloatOrderView => ({
  periodId: 'p-1',
  date: '2026-10-05' as never,
  shiftTypeId: 'st-d',
  role: 'RN',
  order:
    volunteer === 'n-bea'
      ? [
          { ...bea, rank: 1, basis: 'volunteer', reason: 'Volunteered' },
          { ...ada, rank: 2 },
        ]
      : [ada, bea],
  excluded: [{ nurseId: 'n-cy', name: 'Cy Nurse', reason: 'Charge nurse for the shift' }],
});

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('floatOut', 'order', (r) => view(r.volunteers[0]));
  bridge.respond('floatOut', 'send', { id: 'flt-1' } as never);
  bridge.respond('floatOut', 'history', [
    {
      id: 'flt-0',
      unitId: 'unit-1',
      nurseId: 'n-bea',
      date: '2026-10-01',
      shiftTypeId: 'st-d',
      toUnit: '4B Telemetry',
      volunteered: false,
      actor: 'manager',
      at: 0,
    },
  ] as never);
  bridge.respond('floatOut', 'recordObjection', { id: 'flt-0' } as never);
  bridge.respond('nurses', 'list', [{ id: 'n-bea', firstName: 'Bea', lastName: 'Nurse' }] as never);
  bridge.respond('units', 'list', [
    { id: 'unit-1', name: '4A Med-Surg' },
    { id: 'unit-2', name: '4B Telemetry' },
  ] as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function openPanel() {
  renderWithApp(<FloatOut unitId="unit-1" periodId="p-1" shift={shift} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Float out' }));
  await screen.findByText('Rotation: not floated in the last year; most junior');
}

describe('floating a nurse out for the shift', () => {
  it('ranks the nurses with their reasons and says who is never floated', async () => {
    await openPanel();
    expect(
      screen.getByText('Rotation: floated 1 time in the last year, last on Wed Apr 1'),
    ).toBeTruthy();
    expect(screen.getByText(/Cy Nurse: Charge nurse for the shift/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Float Cy Nurse' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Float Bea Nurse' })).toBeNull();
  });

  it('puts the volunteer on top once ticked, and asks for the order again with them', async () => {
    await openPanel();
    fireEvent.click(screen.getByLabelText('Bea Nurse volunteered to float'));
    expect(await screen.findByRole('button', { name: 'Float Bea Nurse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Float Ada Nurse' })).toBeNull();
    expect(bridge.callsTo('floatOut', 'order').at(-1)).toEqual([
      {
        periodId: 'p-1',
        date: '2026-10-05',
        shiftTypeId: 'st-d',
        role: 'RN',
        volunteers: ['n-bea'],
      },
    ]);
  });

  it('will not float anyone until the receiving unit is named', async () => {
    await openPanel();
    const button = screen.getByRole('button', { name: 'Float Ada Nurse' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('To unit'), { target: { value: '4B Telemetry' } });
    expect(button.disabled).toBe(false);
  });

  it('floats the first nurse only after the manager confirms, with the objection', async () => {
    await openPanel();
    fireEvent.change(screen.getByLabelText('To unit'), { target: { value: '4B Telemetry' } });
    fireEvent.change(screen.getByLabelText('Nurse’s objection'), {
      target: { value: 'Not competent on tele' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Float Ada Nurse' }));
    expect(bridge.callsTo('floatOut', 'send')).toEqual([]);
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() =>
      expect(bridge.callsTo('floatOut', 'send')).toEqual([
        [
          {
            periodId: 'p-1',
            date: '2026-10-05',
            shiftTypeId: 'st-d',
            role: 'RN',
            volunteers: [],
            nurseId: 'n-ada',
            toUnit: '4B Telemetry',
            objection: 'Not competent on tele',
            reason: 'Floated to 4B Telemetry',
          },
        ],
      ]),
    );
  });

  it('leaves everyone on the shift when the manager backs out of the confirmation', async () => {
    await openPanel();
    fireEvent.change(screen.getByLabelText('To unit'), { target: { value: '4B Telemetry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Float Ada Nurse' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(bridge.callsTo('floatOut', 'send')).toEqual([]);
  });

  it('records an objection against a recent float', async () => {
    await openPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Record objection for Bea Nurse' }));
    fireEvent.change(screen.getByLabelText('Objection from Bea Nurse'), {
      target: { value: 'Not competent on tele' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save objection' }));
    await waitFor(() =>
      expect(bridge.callsTo('floatOut', 'recordObjection')).toEqual([
        ['flt-0', 'Not competent on tele'],
      ]),
    );
  });
});
