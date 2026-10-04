// @vitest-environment jsdom
/**
 * The grid's drag and drop, driven through the DOM the way a manager drives it. jsdom has no
 * DataTransfer, so a plain object stands in for the one the browser hands every drag event —
 * the chip writes to it on dragstart and the cell reads it back on drop, exactly as in Chromium.
 */

import { type Assignment, isoDate, type Nurse, type Violation } from '@shiftnurse/core';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
} from '@shiftnurse/core/testing';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GridColumn, ScheduleGrid } from './grid.js';
import { ShiftPalette } from './palette.js';

class FakeDataTransfer {
  private data = new Map<string, string>();
  dropEffect = 'none';
  effectAllowed = 'all';
  setData(type: string, value: string) {
    this.data.set(type, value);
  }
  getData(type: string) {
    return this.data.get(type) ?? '';
  }
}

const COLUMNS: GridColumn[] = [
  { date: isoDate('2026-10-05'), weekday: 1, isWeekend: false },
  { date: isoDate('2026-10-06'), weekday: 2, isWeekend: false },
];

let alice: Nurse;
let ben: Nurse;

beforeEach(() => {
  resetFixtureCounters();
  alice = makeNurse({ firstName: 'Alice', lastName: 'Adams' });
  ben = makeNurse({ firstName: 'Ben', lastName: 'Brown' });
});

afterEach(cleanup);

function renderGrid(assignments: Assignment[], readOnly = false, focusNurseId?: string) {
  const onMove = vi.fn();
  const onCreate = vi.fn();
  render(
    <>
      <ShiftPalette shiftTypes={[DAY_12, NIGHT_12]} readOnly={readOnly} />
      <ScheduleGrid
        nurses={[alice, ben]}
        shiftTypes={[DAY_12, NIGHT_12]}
        columns={COLUMNS}
        assignments={assignments}
        pendingIds={new Set()}
        readOnly={readOnly}
        focusNurseId={focusNurseId}
        violationsByAssignment={new Map()}
        violationsByNurse={new Map()}
        violationsByDate={new Map()}
        onMove={onMove}
        onCreate={onCreate}
        onChipOpen={vi.fn()}
        onChipDelete={vi.fn()}
      />
    </>,
  );
  return { onMove, onCreate };
}

function cell(nurse: Nurse, date: string): HTMLElement {
  return screen.getByRole('gridcell', {
    name: new RegExp(`${nurse.firstName}.*${weekdayLabel(date)}`),
  });
}

function weekdayLabel(date: string): string {
  // Matches the cell's accessible name, which carries the date as the grid prints it.
  return date === '2026-10-05' ? 'Mon' : 'Tue';
}

function drag(from: HTMLElement, to: HTMLElement): void {
  const dataTransfer = new FakeDataTransfer();
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragEnter(to, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
}

describe('dragging shifts on the schedule grid', () => {
  it("moves Alice's Monday day shift to Ben's Tuesday when dropped there", () => {
    const shift = assign(alice.id, DAY_12, '2026-10-05');
    const { onMove, onCreate } = renderGrid([shift]);
    const chip = within(cell(alice, '2026-10-05')).getByTestId('assignment-chip');

    drag(chip, cell(ben, '2026-10-06'));

    expect(onMove).toHaveBeenCalledWith({
      assignmentId: shift.id,
      nurseId: ben.id,
      shiftTypeId: DAY_12.id,
      date: '2026-10-06',
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('adds a night shift for Ben when one is dragged from the palette onto his Monday', () => {
    const { onMove, onCreate } = renderGrid([]);
    const nightTile = screen.getByText(NIGHT_12.abbreviation).closest('[draggable]');

    drag(nightTile as HTMLElement, cell(ben, '2026-10-05'));

    expect(onCreate).toHaveBeenCalledWith({
      nurseId: ben.id,
      shiftTypeId: NIGHT_12.id,
      date: '2026-10-05',
    });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('will not pick up a locked shift', () => {
    const locked = assign(alice.id, DAY_12, '2026-10-05', { isLocked: true });
    const { onMove } = renderGrid([locked]);
    const chip = within(cell(alice, '2026-10-05')).getByTestId('assignment-chip');

    expect(chip.getAttribute('draggable')).toBe('false');
    drag(chip, cell(ben, '2026-10-06'));

    expect(onMove).not.toHaveBeenCalled();
  });

  it('ignores drops on an archived, read-only schedule', () => {
    const shift = assign(alice.id, DAY_12, '2026-10-05');
    const { onMove } = renderGrid([shift], true);
    const chip = within(cell(alice, '2026-10-05')).getByTestId('assignment-chip');

    drag(chip, cell(ben, '2026-10-06'));

    expect(onMove).not.toHaveBeenCalled();
  });

  it('ignores a file dropped from the desktop, which carries no shift', () => {
    const { onMove, onCreate } = renderGrid([]);
    fireEvent.drop(cell(ben, '2026-10-05'), { dataTransfer: new FakeDataTransfer() });
    expect(onMove).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('showing one nurse on the schedule grid', () => {
  it("marks only Ben's row when a link asks to see Ben", () => {
    renderGrid([], false, ben.id);
    const rows = document.querySelectorAll('[role="row"][data-nurse-id]');
    const marked = [...rows].filter((r) => r.getAttribute('data-highlighted') === 'true');
    expect(marked.map((r) => r.getAttribute('data-nurse-id'))).toEqual([ben.id]);
  });
});

describe('marking violations on a chip by shape as well as colour', () => {
  function renderWith(severity: 'hard' | 'soft') {
    const a = assign(alice.id, DAY_12, '2026-10-05');
    const violation = {
      ruleId: 'x',
      severity,
      message: 'Too much',
      nurseIds: [alice.id],
      dates: [],
      assignmentIds: [a.id],
    } as unknown as Violation;
    render(
      <ScheduleGrid
        nurses={[alice]}
        shiftTypes={[DAY_12]}
        columns={COLUMNS}
        assignments={[a]}
        pendingIds={new Set()}
        readOnly={false}
        violationsByAssignment={new Map([[a.id, [violation]]])}
        violationsByNurse={new Map()}
        violationsByDate={new Map()}
        onMove={vi.fn()}
        onCreate={vi.fn()}
        onChipOpen={vi.fn()}
        onChipDelete={vi.fn()}
      />,
    );
    return screen.getByTestId('assignment-chip');
  }

  it('draws an octagon on a hard breach and no triangle', () => {
    const chip = renderWith('hard');
    expect(chip.querySelector('[data-severity="hard"] polygon')?.getAttribute('points')).toContain(
      '3,0.5',
    );
    expect(chip.querySelector('[data-severity="soft"]')).toBeNull();
    expect(chip.className).toContain('border-solid');
  });

  it('draws a triangle on a soft breach and a dashed outline', () => {
    const chip = renderWith('soft');
    expect(chip.querySelector('[data-severity="soft"] polygon')?.getAttribute('points')).toBe(
      '5,0.5 9.8,9.5 0.2,9.5',
    );
    expect(chip.querySelector('[data-severity="hard"]')).toBeNull();
    expect(chip.className).toContain('border-dashed');
  });
});
