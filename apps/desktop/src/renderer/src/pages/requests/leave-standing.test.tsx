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
    projectedHours: 20,
    accruedHours: 0,
    usedHours: 0,
    forfeitedHours: 0,
    usedThisYearHours: 0,
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
    expect(screen.getByText(/PTO: 20 h projected on/)).toBeTruthy();
    expect(screen.getByText(/^Payroll: 20 h on/).textContent).not.toMatch(
      /accrued|approved|forfeited/,
    );
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

  it('tells the manager a 72/80 nurse is charged 40 hours of leave for a 36-hour week off', async () => {
    renderWithApp(
      <NewRequestDialog
        open
        onOpenChange={() => {}}
        unitId="unit-1"
        periodId={undefined}
        nurses={[{ ...ana, scheduleKind: 'va_72_80' }]}
      />,
      { unit },
    );
    await fillRequest();
    expect(
      await screen.findByText(/Charged as 40\.00 h of leave: 10 hours for each 9 of absence/),
    ).toBeTruthy();
  });

  it('says nothing of a leave charge for a standard nurse', async () => {
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
    await screen.findByText(/PTO: 20 h projected on/);
    expect(screen.queryByText(/Charged as/)).toBeNull();
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
        regime: 'title1',
        weeklyHours: 36,
        entitlementHours: 432,
        basis: 'contract',
        period: { from: isoDate('2025-10-06'), to: isoDate('2026-10-05') },
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
    expect(screen.getByText(/360 hours left of 432 \(12 × usual week\)/)).toBeTruthy();
    expect(screen.getByText(/FMLA, Title I:/)).toBeTruthy();
    expect(screen.getByText(/No FMLA certification on file covers the first day/)).toBeTruthy();
  });
});

describe('a California nurse’s leave', () => {
  it('warns that 16 sick hours would take use 8 past the 40-hour yearly cap, balance or no', async () => {
    bridge.respond('leaveBalances', 'checkRequest', {
      balance: {
        type: 'sick',
        balanceHours: 60,
        asOf: isoDate('2026-10-01'),
        projectedHours: 52,
        accruedHours: 0,
        usedHours: 8,
        forfeitedHours: 0,
        usedThisYearHours: 32,
        check: { ok: true, remainingHours: 36 },
        useCap: { capHours: 40, overBy: 8 },
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
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'sick' } });
    expect(
      await screen.findByText(
        '32 hours used this leave year; this request would take use 8 past the 40-hour yearly cap.',
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Add request' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows pregnancy disability leave left of the four months', async () => {
    bridge.respond('leaveBalances', 'checkRequest', {
      pdl: {
        entitlementHours: 623.88,
        weeklyHours: 36,
        period: { from: isoDate('2025-10-06'), to: isoDate('2026-10-05') },
        usedHours: 72,
        requestHours: 36,
        remainingHours: 551.88,
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
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'pregnancy_disability' } });
    expect(
      await screen.findByText(
        /Pregnancy disability leave: 551\.88 hours left of 623\.88 \(four months of a 36-hour week\)/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/FMLA certification/)).toBeNull();
  });
});

describe('a VA nurse’s leave', () => {
  it('shows an annual-leave balance projected to the first day, with where it came from', async () => {
    bridge.respond('leaveBalances', 'checkRequest', {
      balance: {
        type: 'annual',
        balanceHours: 100,
        asOf: isoDate('2026-09-07'),
        projectedHours: 116,
        accruedHours: 24,
        usedHours: 8,
        forfeitedHours: 0,
        usedThisYearHours: 8,
        check: { ok: true, remainingHours: 80 },
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
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'annual' } });
    expect(await screen.findByText(/Annual leave: 116 h projected on/)).toBeTruthy();
    // Zero parts (nothing forfeited) are left out of the payroll line.
    expect(screen.getByText(/^Payroll: 100 h on/).textContent).toMatch(
      /^Payroll: 100 h on .+ · \+24 accrued · −8 approved since$/,
    );
  });

  it('shows Title 5, the 480-hour entitlement and the 12 months it is counted in', async () => {
    bridge.respond('leaveBalances', 'checkRequest', {
      fmla: {
        regime: 'title5',
        weeklyHours: 40,
        entitlementHours: 480,
        basis: 'title5_tour',
        period: { from: isoDate('2026-10-05'), to: isoDate('2027-10-04') },
        requestHours: 40,
        remainingHours: 480,
        eligibility: { eligible: true },
        certified: true,
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
    expect(
      await screen.findByText(
        /FMLA, Title 5 \(federal\): 480 hours left of 480 \(6 × biweekly tour\)/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Counted in the 12 months .*2026.* to .*2027/)).toBeTruthy();
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
