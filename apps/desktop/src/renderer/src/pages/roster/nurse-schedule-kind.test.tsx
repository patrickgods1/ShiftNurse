// @vitest-environment jsdom
/**
 * A nurse's schedule plan: the VA's 72/80 and Baylor nurses are judged on hours worked, not the
 * hours payroll pays, so choosing a plan must fill the worked figures. Clearing it must cross IPC
 * as `null`; an omitted key would leave the plan, and its pay divisor, in place.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NurseFormDialog } from './nurse-form-dialog.js';

const ana: Nurse = {
  id: 'n-ana',
  unitId: 'unit-1',
  employeeId: 'E1',
  firstName: 'Ana',
  lastName: 'Cruz',
  role: 'RN',
  employmentType: 'full_time',
  fte: 1,
  contractedHoursPerPeriod: 80,
  seniorityDate: isoDate('2021-10-05'),
  isChargeEligible: false,
  isNovice: false,
  isFloatEligible: false,
  active: true,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('nurses', 'update', ana);
  bridge.respond('nurses', 'create', ana);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const open = (nurse?: Nurse, payPeriodDays = 14) =>
  renderWithApp(
    <NurseFormDialog
      open
      onOpenChange={() => {}}
      unitId="unit-1"
      payPeriodDays={payPeriodDays}
      {...(nurse ? { nurse } : {})}
    />,
  );

const planSelect = async () =>
  (await screen.findByRole('combobox', { name: /Schedule plan/ })) as HTMLSelectElement;
const fte = () => screen.getByLabelText('FTE') as HTMLInputElement;
const hours = () => screen.getByLabelText(/Contracted hours/) as HTMLInputElement;

describe('choosing a nurse’s schedule plan', () => {
  it('fills 0.9 FTE and 72 worked hours for a 72/80 nurse', async () => {
    open();
    fireEvent.change(await planSelect(), { target: { value: 'va_72_80' } });
    expect(fte().value).toBe('0.9');
    expect(hours().value).toBe('72');
  });

  it('fills 1.0 FTE and 48 worked hours for the Baylor plan', async () => {
    open();
    fireEvent.change(await planSelect(), { target: { value: 'va_baylor' } });
    expect(fte().value).toBe('1');
    expect(hours().value).toBe('48');
  });

  it('leaves the numbers alone when going back to standard', async () => {
    open();
    const select = await planSelect();
    fireEvent.change(select, { target: { value: 'va_72_80' } });
    fireEvent.change(select, { target: { value: 'standard' } });
    expect(fte().value).toBe('0.9');
    expect(hours().value).toBe('72');
    fireEvent.change(select, { target: { value: '' } });
    expect(fte().value).toBe('0.9');
    expect(hours().value).toBe('72');
  });

  it('scales the worked hours to a 28-day pay period', async () => {
    open(undefined, 28);
    const select = await planSelect();
    fireEvent.change(select, { target: { value: 'va_72_80' } });
    expect(hours().value).toBe('144');
    fireEvent.change(select, { target: { value: 'va_baylor' } });
    expect(hours().value).toBe('96');
  });

  it('shows an existing nurse’s plan without touching her hours', async () => {
    open({ ...ana, scheduleKind: 'va_72_80', fte: 0.9, contractedHoursPerPeriod: 70 });
    expect((await planSelect()).value).toBe('va_72_80');
    expect(fte().value).toBe('0.9');
    expect(hours().value).toBe('70');
  });

  it('sends the plan and its worked hours when adding a nurse', async () => {
    open();
    fireEvent.change(await screen.findByLabelText('Employee ID'), { target: { value: 'E9' } });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Bo' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lee' } });
    fireEvent.change(screen.getByLabelText('Seniority date'), { target: { value: '2020-01-01' } });
    fireEvent.change(await planSelect(), { target: { value: 'va_72_80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add nurse' }));
    await waitFor(() => expect(bridge.callsTo('nurses', 'create')).toHaveLength(1));
    expect(bridge.callsTo('nurses', 'create')[0]![0]).toMatchObject({
      scheduleKind: 'va_72_80',
      fte: 0.9,
      contractedHoursPerPeriod: 72,
    });
  });

  it('clears the plan by sending null, not by leaving the key out', async () => {
    open({ ...ana, scheduleKind: 'va_baylor' });
    fireEvent.change(await planSelect(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bridge.callsTo('nurses', 'update')).toHaveLength(1));
    expect(bridge.callsTo('nurses', 'update')[0]![1]).toEqual({ scheduleKind: null });
  });
});
