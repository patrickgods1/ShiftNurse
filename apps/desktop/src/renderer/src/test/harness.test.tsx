// @vitest-environment jsdom
/**
 * Proves the harness end to end on a real dialog: the manager denies a request, and the test
 * sees exactly what would have gone over IPC and what the screen says when main refuses.
 */

import { isoDate, type TimeOffRequest } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecideDialog } from '../pages/requests/decide-dialog.js';
import { type FakeBridge, installFakeBridge } from './fake-bridge.js';
import { renderWithApp } from './render.js';

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

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function renderDialog() {
  return renderWithApp(
    <DecideDialog
      request={request}
      period={undefined}
      unitId="unit-1"
      nursesById={new Map()}
      shiftTypesById={new Map()}
      onClose={() => {}}
    />,
  );
}

async function typeReasonAndDeny(reason: string) {
  const box = await screen.findByTestId('decision-reason');
  fireEvent.change(box, { target: { value: reason } });
  fireEvent.click(screen.getByTestId('deny-request'));
}

describe('denying a time-off request from the review dialog', () => {
  it('sends the request id and the reason as typed, without stray spaces', async () => {
    renderDialog();
    await typeReasonAndDeny('  Three nurses already off that weekend ');
    await waitFor(() =>
      expect(bridge.callsTo('timeOff', 'deny')).toEqual([
        ['req-1', 'Three nurses already off that weekend'],
      ]),
    );
  });

  it('tells the manager why when main refuses the denial', async () => {
    bridge.fail(
      'timeOff',
      'deny',
      new Error('That request was already decided. Reload and try again.'),
    );
    renderDialog();
    await typeReasonAndDeny('Short staffed');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('That request was already decided. Reload and try again.');
  });
});
