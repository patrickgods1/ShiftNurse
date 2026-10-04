// @vitest-environment jsdom
/**
 * The credential numbers on the Dashboard must read as one story: the tile, Next steps and the
 * table once used two windows under one word ("expiring": 9 and 1) and looked contradictory.
 */

import type { DashboardSummary, ExpiringCredentialView } from '@shared/api.js';
import {
  addDays,
  type Credential,
  type IsoDate,
  type Nurse,
  type NurseCredential,
  type SchedulePeriod,
  today,
  type Unit,
} from '@shiftnurse/core';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import DashboardPage from './dashboard.js';

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;
const acls = { id: 'cred-1', code: 'ACLS', name: 'ACLS', tracksExpiry: true } as Credential;

function view(n: number, daysFromNow: number): ExpiringCredentialView {
  return {
    nurse: { id: `n${n}`, firstName: `First${n}`, lastName: `Last${n}` } as Nurse,
    credential: acls,
    nurseCredential: {
      id: `nc${n}`,
      nurseId: `n${n}`,
      credentialId: acls.id,
      expiresOn: addDays(today(), daysFromNow),
    } as NurseCredential,
  };
}

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    unit,
    today: today(),
    activeNurses: 4,
    currentDraft: undefined,
    draftShifts: 0,
    latestPublished: undefined,
    pendingTimeOff: 0,
    openCallOffs: 0,
    expiringCredentials: [],
    lapsedCredentials: [],
    todayOnShift: [],
    ...over,
  };
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('shiftTypes', 'list', []);
  bridge.respond('coverage', 'list', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('credentials on the dashboard', () => {
  it('says the same thing in the tile, the next step and the table', async () => {
    bridge.respond(
      'dashboard',
      'summary',
      summary({
        lapsedCredentials: [view(1, -10)],
        expiringCredentials: [view(2, 12), view(3, 70)],
      }),
    );
    renderWithApp(<DashboardPage />, { unit });

    const tile = await screen.findByText('Credentials lapsed or expiring (90 days)');
    const card = tile.closest('[data-testid="stat-card"]') as HTMLElement;
    expect(within(card).getByText('3')).toBeTruthy();
    expect(within(card).getByText('1 lapsed · 1 within 30 days')).toBeTruthy();

    const steps = screen.getByTestId('next-steps').textContent ?? '';
    expect(steps).toContain('1 credential has lapsed — Roster');
    expect(steps).toContain('Follow up 1 credential expiring within 30 days');
    expect(steps.indexOf('lapsed')).toBeLessThan(steps.indexOf('within 30 days'));

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Last1');
    expect(rows[0]?.textContent).toContain('Lapsed ');
  });

  it('names the window when nothing has lapsed or is expiring', async () => {
    bridge.respond('dashboard', 'summary', summary());
    renderWithApp(<DashboardPage />, { unit });
    expect(
      await screen.findByText('No credentials have lapsed or expire in the next 90 days.'),
    ).toBeTruthy();
    expect(screen.getByText('0 lapsed · 0 within 30 days')).toBeTruthy();
  });
});

describe('the posting notice on the dashboard', () => {
  const draft = {
    id: 'p1',
    unitId: 'unit-1',
    name: 'November',
    startDate: '2026-11-01',
    endDate: '2026-11-14',
    status: 'draft',
  } as SchedulePeriod;

  it('says when the next schedule should be posted', async () => {
    bridge.respond(
      'dashboard',
      'summary',
      summary({ currentDraft: draft, postBy: '2026-10-18' as IsoDate }),
    );
    renderWithApp(<DashboardPage />, { unit });
    expect((await screen.findByTestId('post-by')).textContent).toBe(
      'Next schedule should be posted by Oct 18, 2026',
    );
  });

  it('says nothing about posting when the unit has no notice rule', async () => {
    bridge.respond('dashboard', 'summary', summary({ currentDraft: draft }));
    renderWithApp(<DashboardPage />, { unit });
    await screen.findByText('Current draft');
    expect(screen.queryByTestId('post-by')).toBeNull();
  });
});
