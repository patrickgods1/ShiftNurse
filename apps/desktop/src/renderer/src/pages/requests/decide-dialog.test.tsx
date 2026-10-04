// @vitest-environment jsdom
/**
 * The approve paths of the review dialog. Denial is covered in test/harness.test.tsx; what is
 * pinned here is what a wrong field name would silently break: the cover plan sent with an
 * approval, and the reason a published schedule demands before shifts come off it.
 */

import type { LeaveCoverOption } from '@shared/api.js';
import {
  type Assignment,
  isoDate,
  type SchedulePeriod,
  type TimeOffImpact,
  type TimeOffRequest,
} from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { DecideDialog } from './decide-dialog.js';

const request: TimeOffRequest = {
  id: 'req-1',
  nurseId: 'nurse-1',
  startDate: isoDate('2026-10-09'),
  endDate: isoDate('2026-10-11'),
  type: 'pto',
  status: 'pending',
  enteredBy: 'manager',
  submittedAt: 0,
};

const period: SchedulePeriod = {
  id: 'period-1',
  unitId: 'unit-1',
  name: 'October',
  startDate: isoDate('2026-10-04'),
  endDate: isoDate('2026-11-14'),
  status: 'draft',
  ruleSetId: 'rs-1',
  ruleSetVersion: 1,
};

const impact = {
  request,
  decision: 'approved',
  introduced: [],
  cleared: [],
  displacedAssignments: [],
  competing: [],
  capacity: [],
} as unknown as TimeOffImpact;

function assignment(id: string, date: string): Assignment {
  return {
    id,
    periodId: 'period-1',
    nurseId: 'nurse-1',
    shiftTypeId: 'st-day',
    date: isoDate(date),
    source: 'solver',
    isLocked: false,
    isCharge: false,
    isOvertime: false,
  };
}

const candidate = (nurseId: string, label: string) => ({
  nurseId,
  label,
  payTier: 'regular',
  overtime: false,
});

const options: LeaveCoverOption[] = [
  {
    assignment: assignment('a-1', '2026-10-09'),
    shortfall: 1,
    candidates: [candidate('nurse-2', 'Ada Park'), candidate('nurse-3', 'Bo Lin')],
  },
  {
    assignment: assignment('a-2', '2026-10-10'),
    shortfall: 1,
    candidates: [candidate('nurse-3', 'Bo Lin')],
  },
];

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('timeOff', 'impact', impact);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function renderDialog(p: SchedulePeriod | undefined = period, onClose = () => {}) {
  return renderWithApp(
    <DecideDialog
      request={request}
      period={p}
      unitId="unit-1"
      nursesById={new Map()}
      shiftTypesById={new Map()}
      onClose={onClose}
    />,
  );
}

describe('approving a time-off request from the review dialog', () => {
  it('approves outright when the nurse is not on the schedule those days', async () => {
    bridge.respond('timeOff', 'coverOptions', []);
    const onClose = vi.fn();
    renderDialog(period, onClose);
    await screen.findByText('Not scheduled on these days: nothing to cover.');
    fireEvent.click(screen.getByTestId('approve-request'));
    await waitFor(() =>
      expect(bridge.callsTo('timeOff', 'approve')).toEqual([['req-1', undefined]]),
    );
    expect(bridge.callsTo('timeOff', 'approveAndCover')).toEqual([]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('passes an optional note along with a plain approval, trimmed', async () => {
    bridge.respond('timeOff', 'coverOptions', []);
    renderDialog();
    await screen.findByText('Not scheduled on these days: nothing to cover.');
    fireEvent.change(screen.getByTestId('decision-reason'), { target: { value: ' Vacation ' } });
    fireEvent.click(screen.getByTestId('approve-request'));
    await waitFor(() =>
      expect(bridge.callsTo('timeOff', 'approve')).toEqual([['req-1', 'Vacation']]),
    );
  });

  it('approves and covers with the best candidate pre-picked for every freed shift', async () => {
    bridge.respond('timeOff', 'coverOptions', options);
    renderDialog();
    const button = await screen.findByRole('button', { name: 'Approve and cover' });
    await waitFor(() => {
      const picks = screen.getAllByTestId('cover-pick') as HTMLSelectElement[];
      expect(picks.map((p) => p.value)).toEqual(['nurse-2', 'nurse-3']);
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.callsTo('timeOff', 'approveAndCover')).toEqual([
        [
          'period-1',
          'req-1',
          undefined,
          [
            { assignmentId: 'a-1', nurseId: 'nurse-2' },
            { assignmentId: 'a-2', nurseId: 'nurse-3' },
          ],
        ],
      ]),
    );
    expect(bridge.callsTo('timeOff', 'approve')).toEqual([]);
  });

  it('sends the cover the manager picked and leaves a shift open when told to', async () => {
    bridge.respond('timeOff', 'coverOptions', options);
    renderDialog();
    await screen.findByRole('button', { name: 'Approve and cover' });
    await waitFor(() => expect(screen.getAllByTestId('cover-pick')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('cover-pick');
    fireEvent.change(first!, { target: { value: 'nurse-3' } });
    fireEvent.change(second!, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('approve-request'));
    await waitFor(() =>
      expect(bridge.callsTo('timeOff', 'approveAndCover')).toEqual([
        ['period-1', 'req-1', undefined, [{ assignmentId: 'a-1', nurseId: 'nurse-3' }]],
      ]),
    );
  });

  it('wants a reason before taking shifts off a schedule staff already hold', async () => {
    bridge.respond('timeOff', 'coverOptions', options);
    renderDialog({ ...period, status: 'published' });
    const button = await screen.findByRole('button', { name: 'Approve and cover' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('decision-reason'), {
      target: { value: '  Family emergency ' },
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.callsTo('timeOff', 'approveAndCover')).toEqual([
        [
          'period-1',
          'req-1',
          'Family emergency',
          [
            { assignmentId: 'a-1', nurseId: 'nurse-2' },
            { assignmentId: 'a-2', nurseId: 'nurse-3' },
          ],
        ],
      ]),
    );
  });

  it('shows the message when main refuses the approval', async () => {
    bridge.respond('timeOff', 'coverOptions', options);
    bridge.fail('timeOff', 'approveAndCover', new Error('Bo Lin is already on that shift.'));
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and cover' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Bo Lin is already on that shift.');
  });
});

describe('denying a time-off request needs a reason', () => {
  it('keeps Deny disabled while the reason is blank or only spaces', async () => {
    bridge.respond('timeOff', 'coverOptions', []);
    renderDialog();
    const deny = (await screen.findByTestId('deny-request')) as HTMLButtonElement;
    expect(deny.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('decision-reason'), { target: { value: '   ' } });
    expect(deny.disabled).toBe(true);
    fireEvent.click(deny);
    expect(bridge.callsTo('timeOff', 'deny')).toEqual([]);
    fireEvent.change(screen.getByTestId('decision-reason'), { target: { value: 'Short' } });
    expect(deny.disabled).toBe(false);
  });
});
