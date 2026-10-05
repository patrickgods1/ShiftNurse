// @vitest-environment jsdom
/**
 * The 05:30 low-census call: the shift has two more RNs than the patients need, and the manager
 * sends home whoever the unit's order says goes first. Each test follows a click to what would
 * cross IPC.
 */

import type { CancellationOrderView, TodayShiftView } from '@shared/api.js';
import type { ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CensusDrop } from './census-drop.js';

const shift = {
  date: '2026-10-05',
  shiftType: { id: 'st-d', abbreviation: 'D12' } as ShiftType,
} as TodayShiftView;
const over = { periodId: 'p-1', role: 'RN' as const, required: 4, staffed: 6, excess: 2 };

const view = (volunteer?: string): CancellationOrderView => ({
  periodId: 'p-1',
  date: '2026-10-05' as never,
  shiftTypeId: 'st-d',
  role: 'RN',
  required: 4,
  staffed: 6,
  excess: 2,
  order:
    volunteer === 'n-bea'
      ? [
          {
            nurseId: 'n-bea',
            assignmentId: 'a-bea',
            name: 'Bea Nurse',
            tier: 'volunteer',
            reason: 'Bea Nurse offered to go home.',
          },
          {
            nurseId: 'n-ada',
            assignmentId: 'a-ada',
            name: 'Ada Nurse',
            tier: 'rotation',
            reason: 'Rotation: no low-census cancellations yet.',
          },
        ]
      : [
          {
            nurseId: 'n-ada',
            assignmentId: 'a-ada',
            name: 'Ada Nurse',
            tier: 'rotation',
            reason: 'Rotation: no low-census cancellations yet.',
          },
          {
            nurseId: 'n-bea',
            assignmentId: 'a-bea',
            name: 'Bea Nurse',
            tier: 'rotation',
            reason: 'Rotation: 1 low-census cancellation, last on Sep 20.',
          },
        ],
  excluded: [
    { nurseId: 'n-cy', name: 'Cy Nurse', reason: 'Cy Nurse is the charge nurse on this shift.' },
  ],
});

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('dayOf', 'cancellationOrder', (_p, _d, _s, _r, volunteers) => view(volunteers[0]));
  bridge.respond('dayOf', 'cancelForCensus', { periodId: 'p-1' } as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('a shift sent over its requirement by a low census', () => {
  it('says how many more than needed and gives each place its reason, charge nurse excluded', async () => {
    renderWithApp(<CensusDrop unitId="unit-1" shift={shift} over={over} />);
    expect(await screen.findByText('Rotation: no low-census cancellations yet.')).toBeTruthy();
    expect(screen.getByText('Census dropped — 2 more than needed')).toBeTruthy();
    expect(screen.getByText('Rotation: 1 low-census cancellation, last on Sep 20.')).toBeTruthy();
    expect(screen.getByText('Cy Nurse is the charge nurse on this shift.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel Cy Nurse' })).toBeNull();
  });

  it('puts the volunteer on top once marked, and asks for the order again with them', async () => {
    renderWithApp(<CensusDrop unitId="unit-1" shift={shift} over={over} />);
    fireEvent.click(await screen.findByLabelText('Bea Nurse volunteered to go home'));
    expect(await screen.findByRole('button', { name: 'Cancel Bea Nurse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel Ada Nurse' })).toBeNull();
    expect(bridge.callsTo('dayOf', 'cancellationOrder').at(-1)).toEqual([
      'p-1',
      '2026-10-05',
      'st-d',
      'RN',
      ['n-bea'],
    ]);
  });

  it('cancels the first nurse only after the manager confirms', async () => {
    renderWithApp(<CensusDrop unitId="unit-1" shift={shift} over={over} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Ada Nurse' }));
    expect(bridge.callsTo('dayOf', 'cancelForCensus')).toEqual([]);
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'cancelForCensus')).toEqual([
        ['p-1', '2026-10-05', 'st-d', 'RN', [], 'n-ada'],
      ]),
    );
  });

  it('leaves everyone on the shift when the manager backs out of the confirmation', async () => {
    renderWithApp(<CensusDrop unitId="unit-1" shift={shift} over={over} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Ada Nurse' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(bridge.callsTo('dayOf', 'cancelForCensus')).toEqual([]);
  });
});
