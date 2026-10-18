// @vitest-environment jsdom
import type { NurseHoursReadout } from '@shared/api.js';
import { type Assignment, isoDate, type Nurse, type ShiftType } from '@shiftnurse/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { AssignmentDialog } from './assignment-dialog.js';
import { swapCandidates } from './swap-candidates.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const hana = { id: 'n-hana', firstName: 'Hana', lastName: 'Okafor' } as Nurse;
const shift = {
  id: 'a-1',
  nurseId: 'n-hana',
  shiftTypeId: 'st-day',
  date: isoDate('2026-09-21'),
  isLocked: false,
  isCharge: false,
  isOvertime: false,
} as Assignment;
const day = { id: 'st-day', name: 'Day 12', durationHours: 12 } as ShiftType;

const readout: NurseHoursReadout = {
  payPeriod: { start: isoDate('2026-09-13'), end: isoDate('2026-09-26') },
  scheduledHours: 72,
  priorHours: 48,
  paidLeaveHours: 0,
  contractedHours: 72,
  complete: true,
};

async function show(
  data: NurseHoursReadout | undefined,
  status: 'pending' | 'error' | 'success',
  assignment: Assignment = shift,
) {
  renderWithApp(
    <AssignmentDialog
      assignment={assignment}
      nurse={hana}
      shiftType={day}
      violations={[]}
      pending={false}
      onClose={() => {}}
      onToggleLock={() => {}}
      onToggleCharge={() => {}}
      onToggleOvertime={() => {}}
      onRemove={() => {}}
      nurses={[hana]}
      dates={[shift.date]}
      onMove={() => {}}
      context={{
        hours: { status, data, error: status === 'error' ? new Error('db is busy') : null },
        alsoOnShift: [],
      }}
      shiftTypes={[day]}
      swapOptions={[]}
      onSwap={() => {}}
    />,
  );
  return (await screen.findByTestId('assignment-hours')).textContent ?? '';
}

describe('the hours on a shift popover', () => {
  it('shows the hours the contract is judged by, with the week before this schedule', async () => {
    const text = await show(readout, 'success');
    expect(text.startsWith('72h of 72h in the pay period')).toBe(true);
    expect(text).toContain('(48h before this schedule)');
  });

  it('warns when only part of the pay period is on record', async () => {
    expect(await show({ ...readout, complete: false }, 'success')).toContain(
      'counts only what is on record',
    );
  });

  it('adds paid leave to the total and names it', async () => {
    // 60 scheduled + 12 leave = 72 of 72; 0 prior hours are not mentioned.
    const text = await show(
      { ...readout, scheduledHours: 60, priorHours: 0, paidLeaveHours: 12 },
      'success',
    );
    expect(text.startsWith('72h of 72h in the pay period')).toBe(true);
    expect(text).toContain('(12h paid leave)');
    expect(text).not.toContain('before this schedule');
  });

  it('says it is counting while the hours load, and why when they fail', async () => {
    expect(await show(undefined, 'pending')).toBe('Counting hours in this pay period…');
    cleanup();
    expect(await show(undefined, 'error')).toBe('Could not count hours: db is busy');
  });
});

describe('the hours on an unsaved shift', () => {
  it('asks the manager to save the shift instead of counting forever', async () => {
    const ghost = { ...shift, id: 'pending-3' };
    expect(await show(undefined, 'pending', ghost)).toBe(
      'Save the shift to see its pay-period hours.',
    );
  });
});

describe('who a shift can be swapped with', () => {
  it('never offers an unsaved shift as a swap', () => {
    const night = { ...shift, id: 'a-2', nurseId: 'n-2', shiftTypeId: 'st-night' };
    const ghost = { ...shift, id: 'pending-9', nurseId: 'n-3', shiftTypeId: 'st-night' };
    expect(swapCandidates([night, ghost], shift).map((a) => a.id)).toEqual(['a-2']);
  });
});
