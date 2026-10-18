// @vitest-environment jsdom
/** The Requests page: the period choice and what hangs off it. */

import {
  type ConflictReport,
  DEFAULT_AUTO_RESOLVE_POLICY,
  isoDate,
  type SchedulePeriod,
  type TimeOffRequest,
  type Unit,
} from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import RequestsPage from './requests.js';

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;

function period(
  id: string,
  start: string,
  end: string,
  status: SchedulePeriod['status'],
): SchedulePeriod {
  return {
    id,
    unitId: 'unit-1',
    name: id,
    startDate: isoDate(start),
    endDate: isoDate(end),
    status,
    ruleSetId: 'rs-1',
    ruleSetVersion: 1,
  };
}

const published = period('p-sep', '2026-09-06', '2026-09-19', 'published');
const draft = period('p-oct', '2026-09-20', '2026-10-03', 'draft');

const pending: TimeOffRequest = {
  id: 'r1',
  nurseId: 'n1',
  startDate: isoDate('2026-09-25'),
  endDate: isoDate('2026-09-25'),
  type: 'pto',
  status: 'pending',
  enteredBy: 'manager',
  submittedAt: 0,
};

const emptyReport: ConflictReport = {
  periodId: draft.id,
  conflicts: [],
  resolutions: [],
  summary: {
    hard: 0,
    soft: 0,
    hardShortfall: 0,
    byKind: {} as ConflictReport['summary']['byKind'],
  },
};

// The page is heavy to import and mount; under a loaded full run the 1s default is too short.
const slow = { timeout: 4000 };

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('periods', 'list', [published, draft]);
  bridge.respond('timeOff', 'listInRange', [pending]);
  bridge.respond('conflicts', 'analyse', emptyReport);
  bridge.respond('conflicts', 'policy', DEFAULT_AUTO_RESOLVE_POLICY);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the Requests page', { timeout: 15000 }, () => {
  it('forgets the picked day when the manager switches to another period', async () => {
    renderWithApp(<RequestsPage />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: /Sep 25/ }, slow));
    expect(await screen.findByText(/Touching/, {}, slow)).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: published.id },
    });

    expect(screen.queryByText(/Touching/)).toBeNull();
  });

  it('saves the request close date once, when the manager leaves the field', async () => {
    renderWithApp(<RequestsPage />, { unit });
    const field = await screen.findByLabelText('Requests for this schedule close on', {}, slow);
    fireEvent.change(field, { target: { value: '0202-10-15' } });
    fireEvent.change(field, { target: { value: '2026-10-15' } });
    expect(bridge.callsTo('periods', 'setRequestsCloseOn')).toEqual([]);

    fireEvent.blur(field);

    // react-query starts the mutation on a microtask, so the call lands just after the blur.
    await waitFor(() =>
      expect(bridge.callsTo('periods', 'setRequestsCloseOn')).toEqual([[draft.id, '2026-10-15']]),
    );
  });

  it('says a request cannot be judged against a draft nobody is rostered on', async () => {
    bridge.respond('periods', 'assignments', []);
    renderWithApp(<RequestsPage />, { unit });
    expect(await screen.findByText('Not built yet', {}, slow)).toBeTruthy();
    expect(screen.queryByText('Covered')).toBeNull();
  });

  it('says Covered once the draft is built and the request leaves no shift short', async () => {
    bridge.respond('periods', 'assignments', [
      {
        id: 'a1',
        periodId: draft.id,
        nurseId: 'n2',
        shiftTypeId: 'st-day',
        date: isoDate('2026-09-25'),
        isLocked: false,
        source: 'manual',
        isCharge: false,
        isOvertime: false,
      },
    ]);
    renderWithApp(<RequestsPage />, { unit });
    expect(await screen.findByText('Covered', {}, slow)).toBeTruthy();
    expect(screen.queryByText('Not built yet')).toBeNull();
  });
});
