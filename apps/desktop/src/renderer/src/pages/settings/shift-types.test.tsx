// @vitest-environment jsdom
/**
 * The shift-type catalogue: a double click must not make two identical shift types, and a mid
 * shift that runs inside a deactivated day shift must still say so on screen.
 */

import type { ShiftType, Unit } from '@shiftnurse/core';
import { isoDate } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastOutlet } from '../../components/toast.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import ShiftTypesPanel from './shift-types.js';

const unit: Unit = {
  id: 'unit-1',
  name: '3 West ICU',
  unitType: 'ICU',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};

function shiftType(overrides: Partial<ShiftType>): ShiftType {
  return {
    id: 'st-1',
    unitId: 'unit-1',
    name: 'Day',
    abbreviation: 'D',
    startTime: '07:00',
    durationHours: 12,
    isNight: false,
    isOnCall: false,
    color: '#1f6f8b',
    sortOrder: 0,
    active: true,
    withinShiftTypeId: null,
    ...overrides,
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

describe('Settings › Shift types', () => {
  it('makes one shift type when Create is double-clicked', async () => {
    bridge.respond('shiftTypes', 'list', []);
    // Never resolves until the test says so, as a slow disk would not.
    let release: (value: ShiftType) => void = () => {};
    bridge.respond(
      'shiftTypes',
      'create',
      () => new Promise<ShiftType>((resolve) => (release = resolve)) as unknown as ShiftType,
    );
    renderWithApp(<ShiftTypesPanel />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Add shift type' }));

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Day' } });
    fireEvent.change(screen.getByLabelText('Abbreviation'), { target: { value: 'D' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '07:00' } });
    fireEvent.change(screen.getByLabelText('Paid hours'), { target: { value: '12' } });

    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(create);
    // A real second click lands after React has rendered the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(create);

    await waitFor(() => expect(bridge.callsTo('shiftTypes', 'create')).toHaveLength(1));
    expect(bridge.callsTo('shiftTypes', 'create')).toHaveLength(1);
    release(shiftType({ id: 'new' }));
  });

  it('shows the inactive shift a mid shift runs inside', async () => {
    bridge.respond('shiftTypes', 'list', [
      shiftType({ id: 'D12', abbreviation: 'D12', active: false }),
      shiftType({
        id: 'M8',
        name: 'Mid',
        abbreviation: 'M8',
        durationHours: 8,
        sortOrder: 1,
        withinShiftTypeId: 'D12',
      }),
    ]);
    renderWithApp(<ShiftTypesPanel />, { unit });
    const row = (await screen.findByText('Mid')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    const select = (await screen.findByLabelText('Runs inside')) as HTMLSelectElement;
    expect(select.value).toBe('D12');
    expect(select.selectedOptions[0]!.textContent).toMatch(/— inactive$/);
  });

  it('does not offer an inactive shift as somewhere a new shift can run', async () => {
    bridge.respond('shiftTypes', 'list', [
      shiftType({ id: 'D12', abbreviation: 'D12', active: false }),
      shiftType({ id: 'N12', name: 'Night', abbreviation: 'N12', sortOrder: 1 }),
    ]);
    renderWithApp(<ShiftTypesPanel />, { unit });
    fireEvent.click(await screen.findByRole('button', { name: 'Add shift type' }));

    const select = (await screen.findByLabelText('Runs inside')) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['', 'N12']);
  });

  describe('a shift published schedules used', () => {
    const night = shiftType({
      id: 'N12',
      name: 'Night 12',
      abbreviation: 'N12',
      startTime: '19:00',
      isNight: true,
    });

    async function openEdit() {
      renderWithApp(
        <>
          <ToastOutlet />
          <ShiftTypesPanel />
        </>,
        { unit },
      );
      const row = (await screen.findByText('Night 12')).closest('tr')!;
      fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    }

    it('keeps a published shift’s hours fixed and says why', async () => {
      bridge.respond('shiftTypes', 'list', [night]);
      bridge.respond('shiftTypes', 'lockedIds', ['N12']);
      await openEdit();

      await waitFor(() =>
        expect((screen.getByLabelText('Paid hours') as HTMLInputElement).disabled).toBe(true),
      );
      expect((screen.getByLabelText('Start time') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByLabelText('Runs inside') as HTMLInputElement).disabled).toBe(true);
      expect(
        screen.getByText(/Published schedules used this shift, so its hours and flags are kept/),
      ).toBeTruthy();
      expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(false);
    });

    it('lets the manager rename a published shift', async () => {
      bridge.respond('shiftTypes', 'list', [night]);
      bridge.respond('shiftTypes', 'lockedIds', ['N12']);
      bridge.respond('shiftTypes', 'update', { ...night, name: 'Nights' });
      await openEdit();
      await waitFor(() =>
        expect((screen.getByLabelText('Paid hours') as HTMLInputElement).disabled).toBe(true),
      );

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nights' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(bridge.callsTo('shiftTypes', 'update')).toHaveLength(1));
      expect(bridge.callsTo('shiftTypes', 'update')[0]).toEqual(['N12', { name: 'Nights' }]);
    });

    it('duplicates a published shift with new hours and reports what still uses the old one', async () => {
      bridge.respond('shiftTypes', 'list', [night]);
      bridge.respond('shiftTypes', 'lockedIds', ['N12']);
      bridge.respond('shiftTypes', 'duplicate', {
        shiftType: shiftType({ id: 'N8', name: 'Night 8', durationHours: 8 }),
        retired: { ...night, active: false },
        draftShiftsOnOld: 2,
        stillInsideOld: ['Late 4'],
      });
      await openEdit();
      fireEvent.click(await screen.findByRole('button', { name: 'Duplicate as a new type' }));

      expect((await screen.findByLabelText('Name')) as HTMLInputElement).toHaveProperty(
        'value',
        'Night 12 (new)',
      );
      expect((screen.getByLabelText('Paid hours') as HTMLInputElement).disabled).toBe(false);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Night 8' } });
      fireEvent.change(screen.getByLabelText('Paid hours'), { target: { value: '8' } });
      fireEvent.click(screen.getByRole('button', { name: 'Duplicate and retire Night 12' }));

      await waitFor(() => expect(bridge.callsTo('shiftTypes', 'duplicate')).toHaveLength(1));
      const [id, changes] = bridge.callsTo('shiftTypes', 'duplicate')[0]!;
      expect(id).toBe('N12');
      expect(changes).toMatchObject({ name: 'Night 8', durationHours: 8 });
      const toast = await screen.findByText(/Night 8 replaces Night 12\./);
      expect(toast.textContent).toContain('2 shifts in draft schedules still use Night 12');
      expect(toast.textContent).toContain('Late 4 still runs inside Night 12');
    });
  });

  it('edits an unused shift’s hours in place', async () => {
    bridge.respond('shiftTypes', 'list', [shiftType({ name: 'Day 12' })]);
    bridge.respond('shiftTypes', 'lockedIds', []);
    renderWithApp(<ShiftTypesPanel />, { unit });
    const row = (await screen.findByText('Day 12')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    // The note and the duplicate button only come from the lockedIds answer, so wait for it.
    await waitFor(() => expect(bridge.callsTo('shiftTypes', 'lockedIds')).toHaveLength(1));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    expect(((await screen.findByLabelText('Paid hours')) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Duplicate as a new type' })).toBeNull();
  });
});
