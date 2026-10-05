// @vitest-environment jsdom
/**
 * What a manager sees about a nurse's leave while writing or deciding a request: the balance
 * warning in payroll's own numbers, and for FMLA the hours left and the eligibility. Warnings
 * only: Add request stays enabled whatever they say.
 */

import type { LeaveRequestCheck } from '@shared/api.js';
import { isoDate, type Nurse, type ShiftType, type TimeOffRequest } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { DecideDialog } from './decide-dialog.js';
import { NewRequestDialog } from './new-request-dialog.js';

const ana = {
  id: 'n-ana',
  firstName: 'Ana',
  lastName: 'Martinez',
  role: 'RN',
  active: true,
  contractedHoursPerPeriod: 72,
} as Nurse;

const short: LeaveRequestCheck = {
  balance: {
    type: 'pto',
    balanceHours: 20,
    asOf: isoDate('2026-10-01'),
    check: {
      ok: false,
      shortHours: 16,
      message: 'This request pays 36 hours; the balance is 20, 16 short.',
    },
  },
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  // A 12-hour unit: a week at 72 hours a pay period is three 12s, 36 hours.
  bridge.respond('shiftTypes', 'list', [
    { id: 'st-d', durationHours: 12, active: true, isOnCall: false } as ShiftType,
  ]);
  bridge.respond('leaveBalances', 'checkRequest', short);
  bridge.respond('timeOff', 'create', {} as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const unit = {
  id: 'unit-1',
  name: '4 West',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};

async function fillRequest() {
  fireEvent.change(await screen.findByLabelText('Nurse'), { target: { value: 'n-ana' } });
  fireEvent.change(screen.getByLabelText('First day off'), { target: { value: '2026-10-05' } });
  fireEvent.change(screen.getByLabelText('Last day off'), { target: { value: '2026-10-11' } });
}

describe('writing a request against the balance on file', () => {
  it('warns that the request pays 36 hours against a balance of 20, and still lets it be added', async () => {
    renderWithApp(
      <NewRequestDialog
        open
        onOpenChange={() => {}}
        unitId="unit-1"
        periodId={undefined}
        nurses={[ana]}
      />,
      { unit },
    );
    await fillRequest();
    expect(
      await screen.findByText('This request pays 36 hours; the balance is 20, 16 short.'),
    ).toBeTruthy();
    expect(screen.getByText(/PTO balance: 20 hours, as of/)).toBeTruthy();
    expect(bridge.callsTo('leaveBalances', 'checkRequest').at(-1)).toEqual([
      'n-ana',
      'pto',
      '2026-10-05',
      '2026-10-11',
      36,
    ]);
    expect(
      (screen.getByRole('button', { name: 'Add request' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('says when a nurse has no balance on file to check against', async () => {
    bridge.respond('leaveBalances', 'checkRequest', { noBalanceFor: 'pto' });
    renderWithApp(
      <NewRequestDialog
        open
        onOpenChange={() => {}}
        unitId="unit-1"
        periodId={undefined}
        nurses={[ana]}
      />,
      { unit },
    );
    await fillRequest();
    expect(await screen.findByText(/No PTO balance is recorded for this nurse/)).toBeTruthy();
  });

  it('shows FMLA hours left and why a nurse is not eligible', async () => {
    bridge.respond('leaveBalances', 'checkRequest', {
      fmla: {
        weeklyHours: 36,
        requestHours: 36,
        remainingHours: 360,
        eligibility: { eligible: false, reason: 'Employed 4 months; FMLA needs 12.' },
        certified: false,
      },
    });
    renderWithApp(
      <NewRequestDialog
        open
        onOpenChange={() => {}}
        unitId="unit-1"
        periodId={undefined}
        nurses={[ana]}
      />,
      { unit },
    );
    await fillRequest();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'fmla' } });
    expect(await screen.findByText('Employed 4 months; FMLA needs 12.')).toBeTruthy();
    expect(screen.getByText(/360 hours left of 12 work weeks \(36 hours a week\)/)).toBeTruthy();
    expect(screen.getByText(/No FMLA certification on file covers the first day/)).toBeTruthy();
  });
});

describe('deciding a request against the balance on file', () => {
  it('puts the balance warning in front of the manager before they approve', async () => {
    const request: TimeOffRequest = {
      id: 'req-1',
      nurseId: 'n-ana',
      startDate: isoDate('2026-10-05'),
      endDate: isoDate('2026-10-11'),
      type: 'pto',
      status: 'pending',
      enteredBy: 'manager',
      submittedAt: 0,
      paidHours: 36,
    };
    renderWithApp(
      <DecideDialog
        request={request}
        period={undefined}
        unitId="unit-1"
        nursesById={new Map([[ana.id, ana]])}
        shiftTypesById={new Map()}
        onClose={() => {}}
      />,
      { unit },
    );
    expect(
      await screen.findByText('This request pays 36 hours; the balance is 20, 16 short.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'checkRequest')[0]).toEqual([
        'n-ana',
        'pto',
        '2026-10-05',
        '2026-10-11',
        36,
      ]),
    );
  });
});
