// @vitest-environment jsdom
/**
 * Roster › Overtime volunteers: the manager records that a nurse offered to work overtime, and
 * each button leads to exactly the payload that would cross IPC.
 */

import type { Nurse, OvertimeVolunteer } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { OvertimeVolunteersSection } from './overtime-volunteers.js';

const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Martinez', active: true } as Nurse;
const ben = { id: 'n-ben', firstName: 'Ben', lastName: 'Okafor', active: true } as Nurse;

const offer: OvertimeVolunteer = {
  id: 'otv-1',
  unitId: 'unit-1',
  nurseId: 'n-ana',
  startDate: '2026-10-05' as OvertimeVolunteer['startDate'],
  endDate: '2026-10-11' as OvertimeVolunteer['endDate'],
  note: 'texted Oct 3: any nights that week',
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('overtimeVolunteers', 'list', [offer]);
  bridge.respond('overtimeVolunteers', 'create', offer);
  bridge.respond('overtimeVolunteers', 'update', offer);
  bridge.respond('overtimeVolunteers', 'remove', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const renderSection = () =>
  renderWithApp(<OvertimeVolunteersSection unitId="unit-1" nurses={[ana, ben]} />);

describe('recording overtime offers on the roster', () => {
  it('lists who offered, when, and how, and says what the rule is for', async () => {
    renderSection();
    expect(await screen.findByText('Ana Martinez')).toBeTruthy();
    expect(screen.getByText('texted Oct 3: any nights that week')).toBeTruthy();
    expect(
      screen.getByText(/an overtime shift must be one the nurse offered to work/),
    ).toBeTruthy();
    expect(screen.getByText(/Turn the rule on under Settings › Rules/)).toBeTruthy();
  });

  it('records a new offer with its dates and note', async () => {
    renderSection();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByTestId('overtime-volunteer-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Nurse'), { target: { value: 'n-ben' } });
    fireEvent.change(dialog.getByLabelText('First day'), { target: { value: '2026-10-12' } });
    fireEvent.change(dialog.getByLabelText('Last day'), { target: { value: '2026-10-13' } });
    fireEvent.change(dialog.getByLabelText(/How the offer was made/), {
      target: { value: ' any nights ' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('overtimeVolunteers', 'create')).toEqual([
        [
          {
            unitId: 'unit-1',
            nurseId: 'n-ben',
            startDate: '2026-10-12',
            endDate: '2026-10-13',
            note: 'any nights',
          },
        ],
      ]),
    );
  });

  it('will not save an offer whose last day is before its first', async () => {
    renderSection();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByTestId('overtime-volunteer-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Nurse'), { target: { value: 'n-ben' } });
    fireEvent.change(dialog.getByLabelText('First day'), { target: { value: '2026-10-13' } });
    fireEvent.change(dialog.getByLabelText('Last day'), { target: { value: '2026-10-12' } });
    expect(dialog.getByText('The last day is before the first.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('extends an offer and clears its note with null', async () => {
    renderSection();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Last day'), { target: { value: '2026-10-14' } });
    fireEvent.change(dialog.getByLabelText(/How the offer was made/), { target: { value: '' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('overtimeVolunteers', 'update')).toEqual([
        ['otv-1', { startDate: '2026-10-05', endDate: '2026-10-14', note: null }],
      ]),
    );
  });

  it('removes an offer only after the manager confirms', async () => {
    renderSection();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(bridge.callsTo('overtimeVolunteers', 'remove')).toEqual([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove offer' }));
    await waitFor(() =>
      expect(bridge.callsTo('overtimeVolunteers', 'remove')).toEqual([['otv-1']]),
    );
  });
});
