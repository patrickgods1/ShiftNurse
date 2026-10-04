// @vitest-environment jsdom
/**
 * Settings › Unit holds how the unit keeps its ratios. A California ICU manager unticks "charge
 * takes patients"; what must cross IPC is the whole setting, and the relief box must not offer
 * a charge nurse who is busy with patients.
 */

import { isoDate, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import UnitPanel from './unit.js';

const unit: Unit = {
  id: 'unit-1',
  name: '3 West ICU',
  unitType: 'ICU',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
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

describe('Settings › Unit ratio staffing', () => {
  it('offers the charge nurse for breaks only once the charge is kept free of patients', async () => {
    renderWithApp(<UnitPanel />, { unit });
    const relieves = (await screen.findByLabelText(
      'The charge nurse relieves for breaks',
    )) as HTMLInputElement;
    expect(relieves.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('The charge nurse takes patients'));
    expect(relieves.disabled).toBe(false);
  });

  it('saves the charge nurse free of patients with a 60-minute break allowance', async () => {
    renderWithApp(<UnitPanel />, { unit });
    fireEvent.click(await screen.findByLabelText('The charge nurse takes patients'));
    fireEvent.change(screen.getByLabelText('Break minutes per nurse per shift'), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByLabelText('The charge nurse relieves for breaks'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    const [id, patch] = bridge.callsTo('units', 'update')[0]!;
    expect(id).toBe('unit-1');
    expect(patch.ratioStaffing).toEqual({
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 60,
      chargeCoversBreaks: true,
    });
  });

  it('will not save a break allowance that is not a whole number of minutes', async () => {
    renderWithApp(<UnitPanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Break minutes per nurse per shift'), {
      target: { value: '22.5' },
    });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves a 14-day posting notice, and clears it when the box is emptied', async () => {
    renderWithApp(<UnitPanel />, { unit: { ...unit, postingLeadDays: 28 } });
    const lead = (await screen.findByLabelText(
      'Post schedules this many days ahead',
    )) as HTMLInputElement;
    expect(lead.value).toBe('28');

    fireEvent.change(lead, { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(1));
    expect(bridge.callsTo('units', 'update')[0]![1].postingLeadDays).toBe(14);

    fireEvent.change(lead, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('units', 'update')).toHaveLength(2));
    expect(bridge.callsTo('units', 'update')[1]![1].postingLeadDays).toBeNull();
  });

  it('will not save a posting notice longer than 90 days', async () => {
    renderWithApp(<UnitPanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Post schedules this many days ahead'), {
      target: { value: '120' },
    });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
