// @vitest-environment jsdom
/**
 * The nurse drawer's Deactivate dialog: what deactivating does to the nurse's shifts is said
 * before the click, a posted shift blocks it, and a nurse deactivated by mistake comes back with
 * Reactivate. Dates read as the roster prints them (`formatDateWithWeekday`).
 */

import type { DeactivationImpact, FutureShiftView } from '@shared/api.js';
import type { Nurse } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NurseDetail } from './nurse-detail.js';

const ana = {
  id: 'n-ana',
  unitId: 'u-1',
  firstName: 'Ana',
  lastName: 'Cruz',
  employeeId: 'E1',
  role: 'RN',
  employmentType: 'full_time',
  fte: 1,
  contractedHoursPerPeriod: 72,
  seniorityDate: '2020-01-01',
  active: true,
  isChargeEligible: false,
  isNovice: false,
  isFloatEligible: false,
} as unknown as Nurse;

function shift(date: string, over: Partial<FutureShiftView> = {}): FutureShiftView {
  return {
    assignmentId: `a-${date}`,
    periodId: 'p-1',
    periodName: 'Autumn',
    date: date as FutureShiftView['date'],
    shiftTypeName: 'Day 12',
    ...over,
  };
}
function impact(over: Partial<DeactivationImpact>): DeactivationImpact {
  return {
    fromDate: '2026-10-17' as DeactivationImpact['fromDate'],
    draft: [],
    published: [],
    ...over,
  };
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('leaveBalances', 'forNurse', { balances: [], certifications: [] });
  bridge.respond('nurses', 'get', ana);
  bridge.respond('incompatibility', 'list', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function openDeactivate() {
  renderWithApp(<NurseDetail nurseId="n-ana" onClose={() => {}} onEdit={() => {}} />);
  // The first render of the drawer pulls in every section; allow for a loaded CI machine.
  fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }, { timeout: 5000 }));
}
describe('deactivating a nurse from the roster', () => {
  it('will not deactivate a nurse who still holds a posted shift, and says which', async () => {
    bridge.respond('nurses', 'deactivationImpact', impact({ published: [shift('2026-10-24')] }));
    await openDeactivate();
    await screen.findByText(/Sat, Oct 24 · Day 12 · Autumn/);
    const button = screen.getAllByRole('button', { name: 'Deactivate' }).at(-1)!;
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(bridge.callsTo('nurses', 'deactivate')).toEqual([]);
    expect(screen.getByRole('link', { name: "Open Ana's schedule" })).toBeTruthy();
  });

  it('says how many draft shifts deactivating takes off, then does it', async () => {
    bridge.respond(
      'nurses',
      'deactivationImpact',
      impact({ draft: [shift('2026-10-20'), shift('2026-10-22')] }),
    );
    bridge.respond('nurses', 'deactivate', { ...ana, active: false });
    await openDeactivate();
    await screen.findByText(
      "Deactivating takes Ana Cruz's 2 draft shifts from Tue, Oct 20 on off the schedule. Their history is kept.",
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' }).at(-1)!);
    await waitFor(() => expect(bridge.callsTo('nurses', 'deactivate')).toEqual([['n-ana']]));
  });

  it('shows main’s refusal in the dialog', async () => {
    bridge.respond('nurses', 'deactivationImpact', impact({ draft: [shift('2026-10-20')] }));
    bridge.fail(
      'nurses',
      'deactivate',
      new Error('Ana Cruz still has 1 shift on published schedules…'),
    );
    await openDeactivate();
    await screen.findByText(/Deactivating takes Ana Cruz's 1 draft shift /);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' }).at(-1)!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Ana Cruz still has 1 shift on published schedules…');
    // Inline only: a toast would say it a second time.
    expect(screen.getAllByText('Ana Cruz still has 1 shift on published schedules…')).toHaveLength(
      1,
    );
  });

  it('tells a nurse with no upcoming shifts that only the roster changes', async () => {
    bridge.respond('nurses', 'deactivationImpact', impact({}));
    await openDeactivate();
    await screen.findByText(
      'Ana Cruz has no shifts from today on. Their history is kept, and they will not appear on new schedules.',
    );
  });

  it('brings an inactive nurse back with Reactivate', async () => {
    bridge.respond('nurses', 'get', { ...ana, active: false });
    bridge.respond('nurses', 'update', ana);
    renderWithApp(<NurseDetail nurseId="n-ana" onClose={() => {}} onEdit={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }, { timeout: 5000 }));
    await waitFor(() =>
      expect(bridge.callsTo('nurses', 'update')).toEqual([['n-ana', { active: true }]]),
    );
  });

  it('keeps Deactivate disabled while the shifts are still being checked', async () => {
    bridge.respond('nurses', 'deactivationImpact', new Promise(() => {}) as never);
    await openDeactivate();
    await screen.findByText("Checking Ana Cruz's shifts from today on…");
    const button = screen.getAllByRole('button', { name: 'Deactivate' }).at(-1)!;
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps Deactivate disabled when the shifts could not be checked', async () => {
    bridge.fail('nurses', 'deactivationImpact', new Error('disk is busy'));
    await openDeactivate();
    await screen.findByText("Could not check Ana Cruz's shifts: disk is busy");
    const button = screen.getAllByRole('button', { name: 'Deactivate' }).at(-1)!;
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('puts focus on Reactivate once the nurse is deactivated', async () => {
    bridge.respond('nurses', 'deactivationImpact', impact({}));
    bridge.respond('nurses', 'deactivate', { ...ana, active: false });
    await openDeactivate();
    await screen.findByText(/has no shifts from today on/);
    bridge.respond('nurses', 'get', { ...ana, active: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' }).at(-1)!);
    const reactivate = await screen.findByRole('button', { name: 'Reactivate' });
    await waitFor(() => expect(document.activeElement).toBe(reactivate));
  });

  it('puts focus on Deactivate once the nurse is reactivated', async () => {
    bridge.respond('nurses', 'get', { ...ana, active: false });
    bridge.respond('nurses', 'update', ana);
    renderWithApp(<NurseDetail nurseId="n-ana" onClose={() => {}} onEdit={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }, { timeout: 5000 }));
    bridge.respond('nurses', 'get', ana);
    const deactivate = await screen.findByRole('button', { name: 'Deactivate' });
    await waitFor(() => expect(document.activeElement).toBe(deactivate));
  });

  it('closes the dialog when the manager follows the link to the schedule', async () => {
    bridge.respond('nurses', 'deactivationImpact', impact({ published: [shift('2026-10-24')] }));
    await openDeactivate();
    fireEvent.click(await screen.findByRole('link', { name: "Open Ana's schedule" }));
    await waitFor(() => expect(screen.queryByText('Deactivate Ana Cruz?')).toBeNull());
  });
});
