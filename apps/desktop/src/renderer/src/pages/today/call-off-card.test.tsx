// @vitest-environment jsdom
/**
 * The 5 am backfill: the manager works down the ranked call list, logs who did not pick up,
 * accepts the one who did, and when nobody does, closes the call-off with a reason. Each test
 * follows a button to what would cross IPC.
 */

import type { CallOffView } from '@shared/api.js';
import type { Nurse, ReplacementReport, ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('will not log a call until the manager says how it went', async () => {
    renderWithApp(<CallOffCard unitId="unit-1" callOff={callOffView} />);
    const maya = within((await screen.findByText('Maya Lindqvist (RN)')).closest('li')!);
    const log = maya.getByRole('button', { name: 'Log' }) as HTMLButtonElement;
    const select = maya.getByLabelText('Call outcome for Maya Lindqvist (RN)') as HTMLSelectElement;
    expect(log.disabled).toBe(true);
    expect(select.selectedOptions[0]!.textContent).toBe('Outcome…');

    fireEvent.change(select, { target: { value: 'declined' } });
    expect(log.disabled).toBe(false);
    fireEvent.click(log);
    await waitFor(() =>
      expect(bridge.callsTo('dayOf', 'logCall')).toEqual([
        ['co-1', 'n-maya', 'declined', undefined],
      ]),
    );
  });

  it('writes the call log in words', async () => {
    const view = {
      ...callOffView,
      attempts: [
        {
          id: 'a-1',
          nurseId: 'n-ana',
          outcome: 'left_message',
          attemptedAt: 0,
        },
      ],
    } as unknown as CallOffView;
    renderWithApp(<CallOffCard unitId="unit-1" callOff={view} />);
    const line = await screen.findByText(/Martinez, Ana — Left message/, undefined, {
      timeout: 5000,
    });
    expect(line.textContent).not.toContain('left_message');
  });

  it('says the shift is still staffed when the call-off leaves nobody short', async () => {
    bridge.respond('dayOf', 'replacements', { ...report, shortfall: 0 } as ReplacementReport);
    renderWithApp(<CallOffCard unitId="unit-1" callOff={callOffView} />);
    expect(
      await screen.findByText('Still fully staffed without them', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/0 nurse-slot/)).toBeNull();
  });

  it('lists the same rule twice when it fires on two different days', async () => {
    const soft = (date: string) => ({
      ruleId: 'min-rest',
      message: `Short rest on ${date}`,
      nurseIds: ['n-ana'],
      dates: [date],
    });
    bridge.respond('dayOf', 'replacements', {
      ...report,
      candidates: [
        {
          ...candidate('n-ana', 'Ana Martinez (RN)', 1),
          softViolationsIntroduced: [soft('2026-10-04'), soft('2026-10-05')],
        },
      ],
    } as unknown as ReplacementReport);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderWithApp(<CallOffCard unitId="unit-1" callOff={callOffView} />);
    expect(
      await screen.findByText('Short rest on 2026-10-05', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByText('Short rest on 2026-10-04')).toBeTruthy();
    const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    errors.mockRestore();
    expect(logged).not.toMatch(/same key/);
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

describe('last overtime on the call list', () => {
  it('shows when an overtime candidate last worked overtime', async () => {
    bridge.respond('dayOf', 'replacements', {
      shortfall: 1,
      candidates: [
        {
          ...candidate('n-ana', 'Ana Martinez (RN)', 1),
          payTier: 'overtime',
          lastOvertimeOn: '2026-01-02',
        },
        candidate('n-maya', 'Maya Lindqvist (RN)', 2),
      ],
      excluded: [],
    } as unknown as ReplacementReport);
    renderWithApp(<CallOffCard unitId="unit-1" callOff={callOffView} />);
    const ana = within((await screen.findByText('Ana Martinez (RN)')).closest('li')!);
    expect(ana.getByText(/Last OT: /)).toBeTruthy();
    const maya = within(screen.getByText('Maya Lindqvist (RN)').closest('li')!);
    expect(maya.queryByText(/Last OT/)).toBeNull();
  });
});
