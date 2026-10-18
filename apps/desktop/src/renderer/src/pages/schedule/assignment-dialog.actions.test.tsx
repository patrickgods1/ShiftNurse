// @vitest-environment jsdom
/** What the buttons on a shift popover hand back: move, swap and change-type. */

import { type Assignment, isoDate, type Nurse, type ShiftType } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { AssignmentDialog } from './assignment-dialog.js';

const hana = { id: 'n-hana', firstName: 'Hana', lastName: 'Okafor', role: 'RN' } as Nurse;
const ivo = { id: 'n-ivo', firstName: 'Ivo', lastName: 'Marsh', role: 'RN' } as Nurse;
const day = { id: 'st-day', name: 'Day 12', abbreviation: 'D12', active: true } as ShiftType;
const night = { id: 'st-night', name: 'Night 12', abbreviation: 'N12', active: true } as ShiftType;
const mon = isoDate('2026-09-21');
const tue = isoDate('2026-09-22');

const shift = {
  id: 'a-1',
  nurseId: hana.id,
  shiftTypeId: day.id,
  date: mon,
  isLocked: false,
  isCharge: false,
  isOvertime: false,
} as Assignment;
const ivosNight = { ...shift, id: 'a-2', nurseId: ivo.id, shiftTypeId: night.id } as Assignment;

let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function show() {
  const onClose = vi.fn();
  const onMove = vi.fn();
  const onSwap = vi.fn();
  renderWithApp(
    <AssignmentDialog
      assignment={shift}
      nurse={hana}
      shiftType={day}
      violations={[]}
      pending={false}
      onClose={onClose}
      onToggleLock={() => {}}
      onToggleCharge={() => {}}
      onToggleOvertime={() => {}}
      onRemove={() => {}}
      nurses={[hana, ivo]}
      dates={[mon, tue]}
      onMove={onMove}
      shiftTypes={[day, night]}
      swapOptions={[{ assignment: ivosNight, nurse: ivo, shiftType: night }]}
      onSwap={onSwap}
    />,
  );
  return { onClose, onMove, onSwap };
}

describe('the shift popover actions', () => {
  it('moves the shift to the nurse and day picked', async () => {
    const { onMove, onClose } = show();
    const move = (await screen.findByText('Move to')).closest('fieldset')!;
    // Nothing is picked yet, so Move would do nothing.
    expect((screen.getByTestId('assignment-move') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(move).getByLabelText('Nurse'), { target: { value: ivo.id } });
    fireEvent.change(within(move).getByLabelText('Date'), { target: { value: tue } });
    fireEvent.click(screen.getByTestId('assignment-move'));

    expect(onMove).toHaveBeenCalledWith({
      assignmentId: 'a-1',
      nurseId: 'n-ivo',
      shiftTypeId: 'st-day',
      date: tue,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('swaps with the colleague picked', async () => {
    const { onSwap, onClose } = show();
    const select = await screen.findByTestId('assignment-swap-with');
    const swap = within(select.closest('div')!.parentElement!).getByRole('button', {
      name: 'Swap',
    }) as HTMLButtonElement;
    expect(swap.disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'a-2' } });
    fireEvent.click(swap);

    expect(onSwap).toHaveBeenCalledWith('a-1', 'a-2');
    expect(onClose).toHaveBeenCalled();
  });

  it('changes the shift type', async () => {
    const { onMove } = show();
    const select = await screen.findByTestId('assignment-change-type');
    // The shift's own type is not offered as a change.
    expect(within(select).queryByText(/D12/)).toBeNull();

    fireEvent.change(select, { target: { value: 'st-night' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));

    // Same nurse, same day: only the type differs.
    expect(onMove).toHaveBeenCalledWith({
      assignmentId: 'a-1',
      nurseId: 'n-hana',
      shiftTypeId: 'st-night',
      date: mon,
    });
  });
});
