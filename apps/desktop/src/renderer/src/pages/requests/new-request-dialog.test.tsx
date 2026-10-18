// @vitest-environment jsdom
/**
 * Entering a time-off request: the paid-hours figure is a suggestion that follows the nurse, the
 * dates and the type until the manager types over it, and a blank field is refused rather than
 * saved as zero.
 */

import { isoDate, type Nurse, type ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NewRequestDialog } from './new-request-dialog.js';

const ana = {
  id: 'n-ana',
  firstName: 'Ana',
  lastName: 'Martinez',
  role: 'RN',
  active: true,
  contractedHoursPerPeriod: 72,
} as Nurse;

const unit = {
  id: 'unit-1',
  name: '4 West',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('shiftTypes', 'list', [
    { id: 'st-d', durationHours: 12, active: true, isOnCall: false } as ShiftType,
  ]);
  bridge.respond('leaveBalances', 'checkRequest', {});
  bridge.respond('timeOff', 'create', {} as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function open() {
  renderWithApp(
    <NewRequestDialog
      open
      onOpenChange={() => {}}
      unitId="unit-1"
      periodId={undefined}
      nurses={[ana]}
    />,
    { unit },
  );
}

async function fill(end: string) {
  fireEvent.change(await screen.findByLabelText('Nurse'), { target: { value: 'n-ana' } });
  fireEvent.change(screen.getByLabelText('First day off'), { target: { value: '2026-10-05' } });
  fireEvent.change(screen.getByLabelText('Last day off'), { target: { value: end } });
}

const paid = () => screen.getByTestId('paid-hours') as HTMLInputElement;

describe('paid hours on a new request', () => {
  it('suggests paid hours again when the manager changes the dates after typing a figure', async () => {
    open();
    await fill('2026-10-07');
    // 3 days x 72 h / (14 days x 12 h) = 1.29 shifts -> 2 shifts -> 24 h.
    await waitFor(() => expect(paid().value).toBe('24'));
    fireEvent.change(paid(), { target: { value: '30' } });
    expect(paid().value).toBe('30');

    fireEvent.change(screen.getByLabelText('Last day off'), { target: { value: '2026-10-11' } });
    // 7 x 72 / 168 = 3 shifts exactly -> 36 h.
    await waitFor(() => expect(paid().value).toBe('36'));

    fireEvent.click(screen.getByRole('button', { name: 'Add request' }));
    await waitFor(() => expect(bridge.callsTo('timeOff', 'create')).toHaveLength(1));
    expect(JSON.stringify(bridge.callsTo('timeOff', 'create')[0])).toContain('"paidHours":36');
  });

  it('will not save a request with the paid hours left blank', async () => {
    open();
    await fill('2026-10-07');
    await waitFor(() => expect(paid().value).toBe('24'));
    fireEvent.change(paid(), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add request' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Enter the paid hours, or 0 if none.',
    );
    expect(bridge.callsTo('timeOff', 'create')).toHaveLength(0);
  });
});
