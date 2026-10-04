// @vitest-environment jsdom
/** The Roster flags a nurse whose credential has lapsed or is about to, in words. */

import type { DashboardSummary, ExpiringCredentialView } from '@shared/api.js';
import {
  addDays,
  type Credential,
  type Nurse,
  type NurseCredential,
  today,
  type Unit,
} from '@shiftnurse/core';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import RosterPage from './roster.js';

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;
const acls = { id: 'cred-1', code: 'ACLS', name: 'ACLS', tracksExpiry: true } as Credential;

function nurse(id: string, lastName: string): Nurse {
  return {
    id,
    unitId: 'unit-1',
    employeeId: `E-${id}`,
    firstName: 'Pat',
    lastName,
    role: 'RN',
    employmentType: 'full_time',
    fte: 1,
    contractedHoursPerPeriod: 72,
    seniorityDate: '2020-01-01',
    isChargeEligible: false,
    isNovice: false,
    active: true,
  } as Nurse;
}

function view(n: Nurse, daysFromNow: number): ExpiringCredentialView {
  return {
    nurse: n,
    credential: acls,
    nurseCredential: {
      id: `nc-${n.id}`,
      nurseId: n.id,
      credentialId: acls.id,
      expiresOn: addDays(today(), daysFromNow),
    } as NurseCredential,
  };
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('credential badges on the roster', () => {
  it('marks a lapsed nurse and a nurse expiring soon, and leaves the rest alone', async () => {
    const lapsed = nurse('n1', 'Expired');
    const soon = nurse('n2', 'Soon');
    const later = nurse('n3', 'Later');
    bridge.respond('nurses', 'list', [lapsed, soon, later]);
    bridge.respond('dashboard', 'summary', {
      unit,
      today: today(),
      activeNurses: 3,
      currentDraft: undefined,
      draftShifts: 0,
      latestPublished: undefined,
      pendingTimeOff: 0,
      openCallOffs: 0,
      expiringCredentials: [view(soon, 12), view(later, 70)],
      lapsedCredentials: [view(lapsed, -3)],
      todayOnShift: [],
    } satisfies DashboardSummary);
    renderWithApp(<RosterPage />, { unit });

    const row = async (name: string) =>
      (await screen.findByText(new RegExp(name))).closest('tr') as HTMLElement;
    expect(within(await row('Expired')).getByText('Lapsed')).toBeTruthy();
    expect(within(await row('Soon')).getByText('Expires soon')).toBeTruthy();
    const laterRow = await row('Later');
    expect(within(laterRow).queryByText('Expires soon')).toBeNull();
    expect(within(laterRow).queryByText('Lapsed')).toBeNull();
  });
});
