// @vitest-environment jsdom
/**
 * Settings › Leave: a VA manager keeps annual leave's carryover at 685 hours and raises it to
 * 700; what must cross IPC is the whole policy. The validator's wording is the manager's to read,
 * and "Use the default" is how a unit forgets its policy.
 */

import { isoDate, type LeavePolicy, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import LeavePanel from './leave.js';

const policy: LeavePolicy = {
  fmla: { regime: 'title5', yearMethod: 'rolling_forward' },
  leaveYearStart: 'first_full_pay_period',
  accrual: [
    {
      balanceType: 'annual',
      roles: ['RN'],
      employmentTypes: ['full_time'],
      tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
      carryoverCapHours: 685,
      citation: 'VA Handbook 5011',
    },
    {
      balanceType: 'sick',
      tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 20 }],
    },
  ],
};

const unit: Unit = {
  id: 'unit-1',
  name: '4A',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
  leavePolicy: policy,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('units', 'update', unit);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('Settings › Leave', () => {
  it('shows the saved policy, with the year method fixed under Title 5', async () => {
    renderWithApp(<LeavePanel />, { unit });
    const regime = (await screen.findByLabelText('FMLA regime')) as HTMLSelectElement;
    expect(regime.value).toBe('title5');
    const method = screen.getByLabelText('FMLA year') as HTMLSelectElement;
    expect(method.disabled).toBe(true);
    expect(method.selectedOptions[0]!.textContent).toBe('Forward from first use');
    expect(screen.getByText(/5 C\.F\.R\. § 630\.1203\(c\)/)).toBeTruthy();
    expect((screen.getByLabelText('Rule 1 RN') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Rule 1 LPN') as HTMLInputElement).checked).toBe(false);
  });

  it('saves a carryover cap raised from 685 to 700 hours, leaving the rest of the policy as it was', async () => {
    renderWithApp(<LeavePanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Rule 1 carryover cap (hours)'), {
      target: { value: '700' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const [id, patch] = bridge.callsTo('units', 'update')[0]!;
    expect(id).toBe('unit-1');
    expect(patch).toEqual({
      leavePolicy: {
        ...policy,
        accrual: [{ ...policy.accrual[0]!, carryoverCapHours: 700 }, policy.accrual[1]!],
      },
    });
  });

  it('shows the validator’s own words when the policy is refused', async () => {
    bridge.fail(
      'units',
      'update',
      new Error(
        'The annual accrual rule must start at 0 years of service, or new staff earn nothing',
      ),
    );
    renderWithApp(<LeavePanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Rule 1 tier 1 from years'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/must start at 0 years of service/)).toBeTruthy();
  });

  it('reorders rules, so the first match can be the specific one', async () => {
    renderWithApp(<LeavePanel />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Move rule 1 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const saved = bridge.callsTo('units', 'update')[0]![1].leavePolicy!;
    expect(saved.accrual.map((r) => r.balanceType)).toEqual(['sick', 'annual']);
  });

  it('adds a rule and a tier earning 1 hour per 30 worked', async () => {
    renderWithApp(<LeavePanel />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Add accrual rule' }));
    fireEvent.change(screen.getByLabelText('Rule 3 balance'), { target: { value: 'sick' } });
    fireEvent.change(screen.getByLabelText('Rule 3 tier 1 earns'), { target: { value: 'hour' } });
    fireEvent.change(screen.getByLabelText('Rule 3 tier 1 N (hours worked)'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const rules = bridge.callsTo('units', 'update')[0]![1].leavePolicy!.accrual;
    expect(rules[2]).toEqual({
      balanceType: 'sick',
      tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 30 }],
    });
  });

  it('keeps a cap in days when the policy is saved again', async () => {
    const sick = {
      ...policy.accrual[1]!,
      balanceCapHours: 80,
      balanceCapDays: 10,
      useCapHoursPerYear: 40,
      useCapDaysPerYear: 5,
    };
    const withDays: LeavePolicy = { ...policy, accrual: [policy.accrual[0]!, sick] };
    renderWithApp(<LeavePanel />, { unit: { ...unit, leavePolicy: withDays } });
    expect(
      ((await screen.findByLabelText('Rule 2 balance cap (days)')) as HTMLInputElement).value,
    ).toBe('10');
    expect((screen.getByLabelText('Rule 2 yearly use cap (days)') as HTMLInputElement).value).toBe(
      '5',
    );
    // An edit to the other rule, so Save has something to send; rule 2 must cross untouched.
    fireEvent.change(screen.getByLabelText('Rule 1 carryover cap (hours)'), {
      target: { value: '700' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const rules = bridge.callsTo('units', 'update')[0]![1].leavePolicy!.accrual;
    expect(rules[1]).toEqual(sick);
  });

  it('keeps the federal 10-hour last pay period when the policy is saved', async () => {
    const lvn = {
      balanceType: 'annual' as const,
      roles: ['LPN' as const],
      tiers: [
        { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
        { fromYearsOfService: 3, hoursPerPayPeriod: 6, lastPayPeriodOfYearHours: 10 },
        { fromYearsOfService: 15, hoursPerPayPeriod: 8 },
      ],
      carryoverCapHours: 240,
    };
    const federal: LeavePolicy = { ...policy, accrual: [policy.accrual[0]!, lvn] };
    renderWithApp(<LeavePanel />, { unit: { ...unit, leavePolicy: federal } });
    expect(
      (
        (await screen.findByLabelText(
          'Rule 2 tier 2 last pay period of the year (hours)',
        )) as HTMLInputElement
      ).value,
    ).toBe('10');
    // An edit to the other rule, so Save has something to send; rule 2 must cross untouched.
    fireEvent.change(screen.getByLabelText('Rule 1 carryover cap (hours)'), {
      target: { value: '700' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const rules = bridge.callsTo('units', 'update')[0]![1].leavePolicy!.accrual;
    expect(rules[1]).toEqual(lvn);
  });

  it('saves California sick leave capped at 40 hours used a year', async () => {
    renderWithApp(<LeavePanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Rule 2 yearly use cap (hours)'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const rules = bridge.callsTo('units', 'update')[0]![1].leavePolicy!.accrual;
    expect(rules[1]).toEqual({ ...policy.accrual[1]!, useCapHoursPerYear: 40 });
  });

  it('saves a sick rule giving 40 hours up front each year, with no earning rate', async () => {
    renderWithApp(<LeavePanel />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Add accrual rule' }));
    fireEvent.change(screen.getByLabelText('Rule 3 balance'), { target: { value: 'sick' } });
    fireEvent.change(screen.getByLabelText('Rule 3 front-loaded each year (hours)'), {
      target: { value: '40' },
    });
    fireEvent.change(screen.getByLabelText('Rule 3 yearly use cap (hours)'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const rules = bridge.callsTo('units', 'update')[0]![1].leavePolicy!.accrual;
    expect(rules[2]).toEqual({
      balanceType: 'sick',
      tiers: [],
      useCapHoursPerYear: 40,
      frontLoadHours: 40,
    });
  });

  it('refuses to save 40 hours up front beside a 4-hour-a-period rate, and saves once the rate is cleared', async () => {
    const sick: LeavePolicy['accrual'][number] = {
      balanceType: 'sick',
      tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 4 }],
    };
    renderWithApp(<LeavePanel />, {
      unit: { ...unit, leavePolicy: { ...policy, accrual: [policy.accrual[0]!, sick] } },
    });
    fireEvent.change(await screen.findByLabelText('Rule 2 front-loaded each year (hours)'), {
      target: { value: '40' },
    });
    expect(
      await screen.findByText(
        'Rule 2: a rule that gives hours up front cannot also earn per period or per hour — remove the earning rates or clear the up-front hours.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(bridge.callsTo('units', 'update')).toHaveLength(0);

    // The last tier row cannot be removed, so emptying its rate is how the rate goes.
    fireEvent.change(screen.getByLabelText('Rule 2 tier 1 hours'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const rules = bridge.callsTo('units', 'update')[0]![1].leavePolicy!.accrual;
    expect(rules[1]).toEqual({ balanceType: 'sick', tiers: [], frontLoadHours: 40 });
  });

  it('saves null when the manager goes back to the default', async () => {
    renderWithApp(<LeavePanel />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Use the default' }));
    await waitFor(() =>
      expect(bridge.callsTo('units', 'update')).toEqual([['unit-1', { leavePolicy: null }]]),
    );
  });

  it('offers nothing to reset on a unit that already runs the default', async () => {
    renderWithApp(<LeavePanel />, { unit: { ...unit, leavePolicy: undefined } });
    expect(
      ((await screen.findByRole('button', { name: 'Use the default' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByLabelText('FMLA regime') as HTMLSelectElement).value).toBe('title1');
  });
});
