// @vitest-environment jsdom
/**
 * Roster › Rest waivers: the manager records a nurse's written waiver with its reason, and each
 * button leads to exactly the payload that would cross IPC.
 */

import type { Nurse, RestWaiver } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { RestWaiversSection } from './rest-waivers.js';

const nina = { id: 'n-nina', firstName: 'Nina', lastName: 'Park', active: true } as Nurse;
const vera = { id: 'n-vera', firstName: 'Vera', lastName: 'Lund', active: true } as Nurse;

const record: RestWaiver = {
  id: 'rwv-1',
  unitId: 'unit-1',
  nurseId: 'n-nina',
  date: '2026-10-06' as RestWaiver['date'],
  reason: 'Signed waiver, took the evening',
  createdAt: 0,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('restWaivers', 'list', [record]);
  bridge.respond('restWaivers', 'create', record);
  bridge.respond('restWaivers', 'remove', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const renderSection = () =>
  renderWithApp(<RestWaiversSection unitId="unit-1" nurses={[nina, vera]} />);

describe('recording a rest waiver on the roster', () => {
  it('lists the nurse, the reason and what a waiver does', async () => {
    renderSection();
    expect(await screen.findByText('Nina Park')).toBeTruthy();
    expect(screen.getByText('Signed waiver, took the evening')).toBeTruthy();
    expect(
      screen.getByText(
        'Lets a turnaround shorter than the minimum rest stand for the shift starting on this date. Needs the nurse’s written waiver.',
      ),
    ).toBeTruthy();
  });

  it('will not save without a reason', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByTestId('rest-waiver-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Nurse'), { target: { value: 'n-vera' } });
    fireEvent.change(dialog.getByLabelText('Shift starting'), { target: { value: '2026-10-07' } });
    expect(dialog.getByText('A reason is required; it goes to the audit log.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('records a waiver with its reason', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByTestId('rest-waiver-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Nurse'), { target: { value: 'n-vera' } });
    fireEvent.change(dialog.getByLabelText('Shift starting'), { target: { value: '2026-10-07' } });
    fireEvent.change(dialog.getByLabelText('Reason'), { target: { value: ' Signed 6 Oct ' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('restWaivers', 'create')).toEqual([
        [{ unitId: 'unit-1', nurseId: 'n-vera', date: '2026-10-07', reason: 'Signed 6 Oct' }],
      ]),
    );
  });

  it('removes a waiver only once a reason is given', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByRole('button', { name: /Remove Nina Park/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect((dialog.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(dialog.getByLabelText('Reason for removing it'), {
      target: { value: 'Nurse withdrew it' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(bridge.callsTo('restWaivers', 'remove')).toEqual([['rwv-1', 'Nurse withdrew it']]),
    );
  });
});
