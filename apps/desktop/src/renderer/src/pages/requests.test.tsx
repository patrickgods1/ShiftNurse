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
import { makeNurse, resetFixtureCounters } from '@shiftnurse/core/testing';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  hasPayData: false,
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

  it('lists the requests waiting for a decision first', async () => {
    resetFixtureCounters();
    const [ana, ben, cy] = ['Ana', 'Ben', 'Cy'].map((firstName) =>
      makeNurse({ firstName, lastName: 'Test' }),
    );
    const request = (
      id: string,
      nurseId: string,
      day: string,
      status: TimeOffRequest['status'],
    ): TimeOffRequest => ({
      ...pending,
      id,
      nurseId,
      startDate: isoDate(day),
      endDate: isoDate(day),
      status,
    });
    // Fed latest-first so the page's own ordering is what puts Cy ahead of Ben.
    bridge.respond('nurses', 'list', [ana!, ben!, cy!]);
    bridge.respond('timeOff', 'listInRange', [
      request('r-ben', ben!.id, '2026-09-28', 'pending'),
      request('r-ana', ana!.id, '2026-09-22', 'approved'),
      request('r-cy', cy!.id, '2026-09-24', 'pending'),
    ]);
    renderWithApp(<RequestsPage />, { unit });

    const queue = (await screen.findByRole('heading', { name: 'Queue' }, slow)).closest('section')!;
    await waitFor(() => expect(within(queue).getAllByTestId('review-request')).toHaveLength(2));
    // The queue opens on Pending: the approved request waits behind its filter, and the two
    // undecided ones run in the order their days fall.
    const names = () =>
      within(queue)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]!.textContent);
    expect(names()).toEqual(['Cy Test', 'Ben Test']);

    fireEvent.click(within(queue).getByRole('button', { name: 'All' }));

    expect(names()).toEqual(['Ana Test', 'Cy Test', 'Ben Test']);
  });

  it('switches to Exchanges', async () => {
    renderWithApp(<RequestsPage />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Exchanges' }, slow));

    expect(await screen.findByRole('heading', { name: /^Exchanges · / }, slow)).toBeTruthy();
    expect(screen.getByText(/^No exchanges yet\./)).toBeTruthy();
    // The time-off queue is gone with its tab.
    expect(screen.queryByRole('heading', { name: 'Queue' })).toBeNull();
  });
});
