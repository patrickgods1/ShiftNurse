// @vitest-environment jsdom
/**
 * A nurse's hire date: optional, for the manager whose bridged or merged service makes it differ
 * from the seniority date. Clearing it must cross IPC as `null`; an omitted key would leave the
 * old date in place and FMLA would keep counting from it.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NurseDetail } from './nurse-detail.js';
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
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const openForm = (nurse: Nurse) =>
  renderWithApp(
    <NurseFormDialog
      open
      onOpenChange={() => {}}
      unitId="unit-1"
      payPeriodDays={14}
      nurse={nurse}
    />,
  );

describe('editing a nurse’s hire date', () => {
  it('saves a hire date set for the first time', async () => {
    openForm(ana);
    fireEvent.change(await screen.findByLabelText('Hire date'), {
      target: { value: '2025-11-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(bridge.callsTo('nurses', 'update')).toEqual([['n-ana', { hireDate: '2025-11-01' }]]),
    );
  });

  it('clears a hire date by sending null, not by leaving the key out', async () => {
    openForm({ ...ana, hireDate: isoDate('2025-11-01') });
    const field = (await screen.findByLabelText('Hire date')) as HTMLInputElement;
    expect(field.value).toBe('2025-11-01');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bridge.callsTo('nurses', 'update')).toHaveLength(1));
    const patch = bridge.callsTo('nurses', 'update')[0]![1];
    expect(patch).toEqual({ hireDate: null });
    expect('hireDate' in patch).toBe(true);
  });

  it('leaves the hire date out of the patch when it was not touched', async () => {
    openForm({ ...ana, hireDate: isoDate('2025-11-01') });
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Anna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bridge.callsTo('nurses', 'update')).toHaveLength(1));
    expect(bridge.callsTo('nurses', 'update')[0]![1]).toEqual({ firstName: 'Anna' });
  });
});

describe('the nurse detail', () => {
  const show = async (nurse: Nurse) => {
    bridge.respondDefault([]);
    bridge.respond('nurses', 'get', nurse);
    renderWithApp(<NurseDetail nurseId="n-ana" onClose={() => {}} onEdit={() => {}} />);
    await screen.findByText('Seniority date');
  };

  it('shows the hire date when one is set', async () => {
    await show({ ...ana, hireDate: isoDate('2025-11-01') });
    expect(screen.getByText('Hire date')).toBeTruthy();
    expect(screen.getByText('Nov 1, 2025')).toBeTruthy();
  });

  it('does not mention a hire date when there is none', async () => {
    await show(ana);
    expect(screen.queryByText('Hire date')).toBeNull();
  });
});
