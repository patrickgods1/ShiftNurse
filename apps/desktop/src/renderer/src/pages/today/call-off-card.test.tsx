// @vitest-environment jsdom
/**
 * The 5 am backfill: the manager works down the ranked call list, logs who did not pick up,
 * accepts the one who did, and when nobody does, closes the call-off with a reason. Each test
 * follows a button to what would cross IPC.
 */

import type { CallOffView } from '@shared/api.js';
import type { Nurse, ReplacementReport, ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CallOffCard } from './call-off-card.js';

const callOffView = {
  callOff: { id: 'co-1', date: '2026-10-05', reportedAt: 0 },
  nurse: { id: 'n-absent', firstName: 'Ben', lastName: 'Okafor', role: 'RN' },
  shiftType: { id: 'st-d', abbreviation: 'D12' } as ShiftType,
  attempts: [],
} as unknown as CallOffView;

function candidate(nurseId: string, label: string, rank: number) {
  return {
    nurseId,
    label,
    payTier: 'straight',
    cost: { delta: 0, unpriced: false },
    burdenIndex: 0,
    softViolationsIntroduced: [],
    rank,
  };
}

const report = {
  shortfall: 1,
  candidates: [
    candidate('n-ana', 'Ana Martinez (RN)', 1),
    candidate('n-maya', 'Maya Lindqvist (RN)', 2),
  ],
  excluded: [],
} as unknown as ReplacementReport;

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('dayOf', 'replacements', report);
  bridge.respond('nurses', 'list', [
    { id: 'n-ana', firstName: 'Ana', lastName: 'Martinez' },
  ] as Nurse[]);
  bridge.respond('dayOf', 'backfill', { assignment: { periodId: 'p-1' } } as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function renderCard() {
  renderWithApp(<CallOffCard unitId="unit-1" callOff={callOffView} />);
  return within(await screen.findByText('Ana Martinez (RN)').then((el) => el.closest('li')!));
}

describe('working the call list for a call-off', () => {
  it('backfills the shift with the nurse who said yes', async () => {
    const ana = await renderCard();
    fireEvent.click(ana.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'backfill')).toEqual([['co-1', 'n-ana', undefined]]),
    );
  });

  it('logs a nurse who did not answer, without covering the shift', async () => {
    const ana = await renderCard();
    fireEvent.change(ana.getByLabelText('Call outcome for Ana Martinez (RN)'), {
      target: { value: 'no_answer' },
    });
    fireEvent.click(ana.getByRole('button', { name: 'Log' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'logCall')).toEqual([
        ['co-1', 'n-ana', 'no_answer', undefined],
      ]),
    );
    expect(bridge.callsTo('dayOf', 'backfill')).toEqual([]);
  });

  it('logs a decline when the manager just presses Log', async () => {
    renderWithApp(<CallOffCard unitId="unit-1" callOff={callOffView} />);
    const maya = within((await screen.findByText('Maya Lindqvist (RN)')).closest('li')!);
    fireEvent.click(maya.getByRole('button', { name: 'Log' }));
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'logCall')).toEqual([
        ['co-1', 'n-maya', 'declined', undefined],
      ]),
    );
  });
});

describe('closing a call-off without a backfill', () => {
  it('will not mark the shift uncovered until the manager says why', async () => {
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Mark uncovered' }));
    const dialog = within(await screen.findByTestId('reason-dialog'));
    const confirm = dialog.getByRole('button', { name: 'Mark uncovered' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(bridge.callsTo('dayOf', 'markUncovered')).toEqual([]);

    fireEvent.change(dialog.getByLabelText('Reason'), {
      target: { value: '  Called six nurses, nobody free  ' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'markUncovered')).toEqual([
        ['co-1', 'Called six nurses, nobody free'],
      ]),
    );
  });

  it('cancels the call-off with the reason once the nurse turned up after all', async () => {
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel call-off' }));
    const dialog = within(await screen.findByTestId('reason-dialog'));
    const confirm = dialog.getByRole('button', { name: 'Cancel call-off' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: 'Ben came in' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'cancelCallOff')).toEqual([['co-1', 'Ben came in']]),
    );
  });
});

describe('overtime offers on the call list', () => {
  it('says whether each candidate offered overtime, in words', async () => {
    bridge.respond('dayOf', 'replacements', {
      shortfall: 1,
      candidates: [
        { ...candidate('n-ana', 'Ana Martinez (RN)', 1), volunteeredForOvertime: true },
        { ...candidate('n-maya', 'Maya Lindqvist (RN)', 2), volunteeredForOvertime: false },
        candidate('n-lee', 'Lee Park (RN)', 3),
      ],
      excluded: [
        { nurseId: 'n-ben', label: 'Ben Okafor (RN)', reason: 'Overtime they have not offered' },
      ],
    } as unknown as ReplacementReport);
    renderWithApp(<CallOffCard unitId="unit-1" callOff={callOffView} />);
    const row = async (label: string) => within((await screen.findByText(label)).closest('li')!);
    expect((await row('Ana Martinez (RN)')).getByText('Offered overtime')).toBeTruthy();
    expect(
      (await row('Maya Lindqvist (RN)')).getByText('No standing offer — ask, don\u2019t require'),
    ).toBeTruthy();
    const lee = await row('Lee Park (RN)');
    expect(lee.queryByText(/Offered overtime|No standing offer/)).toBeNull();
    fireEvent.click(screen.getByText('Not eligible (1)'));
    expect(screen.getByText(/Ben Okafor \(RN\) — Overtime they have not offered/)).toBeTruthy();
  });
});
