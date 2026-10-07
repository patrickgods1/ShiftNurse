// @vitest-environment jsdom
/**
 * A nurse's permanent tour: the Tour rotation rule keeps her on it. Going back to "Rotates" must
 * cross IPC as `null`; an omitted key would leave the tour in place and the rule would keep
 * flagging every shift off it.
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

const tourSelect = async () =>
  (await screen.findByRole('combobox', { name: /Permanent tour/ })) as HTMLSelectElement;

describe('editing a nurse’s permanent tour', () => {
  it('starts on "Rotates (none)" for a nurse with no permanent tour', async () => {
    openForm(ana);
    expect((await tourSelect()).value).toBe('');
    expect(screen.getByText(/never rotated off it when the Tour rotation rule is on/)).toBeTruthy();
  });

  it('puts a nurse on permanent nights', async () => {
    openForm(ana);
    fireEvent.change(await tourSelect(), { target: { value: 'night' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(bridge.callsTo('nurses', 'update')).toEqual([['n-ana', { permanentTour: 'night' }]]),
    );
  });

  it('takes a nurse off her permanent tour by sending null, not by leaving the key out', async () => {
    openForm({ ...ana, permanentTour: 'night' });
    const select = await tourSelect();
    expect(select.value).toBe('night');
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bridge.callsTo('nurses', 'update')).toHaveLength(1));
    const patch = bridge.callsTo('nurses', 'update')[0]![1];
    expect(patch).toEqual({ permanentTour: null });
    expect('permanentTour' in patch).toBe(true);
  });

  it('leaves the tour out of the patch when it was not touched', async () => {
    openForm({ ...ana, permanentTour: 'night' });
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Anna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bridge.callsTo('nurses', 'update')).toHaveLength(1));
    expect(bridge.callsTo('nurses', 'update')[0]![1]).toEqual({ firstName: 'Anna' });
  });
});
