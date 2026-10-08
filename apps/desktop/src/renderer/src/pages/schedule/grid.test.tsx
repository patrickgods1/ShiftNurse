// @vitest-environment jsdom
/**
 * The grid's drag and drop, driven through the DOM the way a manager drives it. jsdom has no
 * DataTransfer, so a plain object stands in for the one the browser hands every drag event —
 * the chip writes to it on dragstart and the cell reads it back on drop, exactly as in Chromium.
 */

import {
  type Assignment,
  isoDate,
  type Nurse,
  type ShiftDemand,
  type Violation,
} from '@shiftnurse/core';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
} from '@shiftnurse/core/testing';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GridColumn, type GridSpotlight, ScheduleGrid } from './grid.js';
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

describe('the month band over the date row', () => {
  it('names October and November when the schedule crosses the month end', () => {
    const columns: GridColumn[] = [
      { date: isoDate('2026-10-31'), weekday: 6, isWeekend: true },
      { date: isoDate('2026-11-01'), weekday: 0, isWeekend: true },
      { date: isoDate('2026-11-02'), weekday: 1, isWeekend: false },
    ];
    render(
      <ScheduleGrid
        nurses={[alice]}
        shiftTypes={[DAY_12]}
        columns={columns}
        assignments={[]}
        pendingIds={new Set()}
        readOnly={false}
        violationsByAssignment={new Map()}
        violationsByNurse={new Map()}
        violationsByDate={new Map()}
        onMove={vi.fn()}
        onCreate={vi.fn()}
        onChipOpen={vi.fn()}
        onChipDelete={vi.fn()}
      />,
    );
    const band = within(screen.getByTestId('month-band')).getAllByRole('columnheader');
    expect(band.map((h) => h.textContent)).toEqual(['', 'October 2026', 'November 2026']);
    expect(band.map((h) => h.getAttribute('aria-colspan'))).toEqual([null, '1', '2']);
  });

  it('pins the month band and the date row as rows, so they stay put while nurses scroll', () => {
    renderGrid([]);
    // A sticky cell cannot leave its one-row-tall parent; only a sticky row can hold the top.
    for (const id of ['month-band', 'date-row']) {
      const row = screen.getByTestId(id);
      expect(row.className, id).toMatch(/\bsticky\b/);
      expect(row.className, id).toMatch(/\btop-/);
      for (const header of within(row).getAllByRole('columnheader')) {
        expect(header.className).not.toMatch(/\btop-/);
      }
    }
  });
});

describe('showing a problem on the grid', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  function renderSpotlit(assignments: Assignment[], spotlight: GridSpotlight) {
    render(
      <ScheduleGrid
        nurses={[alice, ben]}
        shiftTypes={[DAY_12]}
        columns={COLUMNS}
        assignments={assignments}
        pendingIds={new Set()}
        readOnly={false}
        spotlight={spotlight}
        violationsByAssignment={new Map()}
        violationsByNurse={new Map()}
        violationsByDate={new Map()}
        onMove={vi.fn()}
        onCreate={vi.fn()}
        onChipOpen={vi.fn()}
        onChipDelete={vi.fn()}
      />,
    );
  }

  it("rings Ben's Tuesday and the shift the alert names, and scrolls to that cell", () => {
    const shift = assign(ben.id, DAY_12, '2026-10-06');
    renderSpotlit([shift, assign(alice.id, DAY_12, '2026-10-06')], {
      date: isoDate('2026-10-06'),
      nurseId: ben.id,
      assignmentIds: [shift.id],
      nonce: 1,
    });
    const lit = [...document.querySelectorAll('[role="gridcell"][data-spotlit]')];
    expect(lit).toHaveLength(1);
    expect(lit[0]).toBe(cell(ben, '2026-10-06'));
    expect(lit[0]?.getAttribute('data-spotlit')).toBe('cell');
    const chips = [...document.querySelectorAll('[data-testid="assignment-chip"][data-spotlit]')];
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['D12 on 2026-10-06']);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(cell(ben, '2026-10-06'));
  });

  it('tints the whole day and scrolls to its header when the alert names no nurse', () => {
    renderSpotlit([], { date: isoDate('2026-10-05'), assignmentIds: [], nonce: 1 });
    const lit = [...document.querySelectorAll('[data-spotlit]')];
    expect(lit.map((el) => el.getAttribute('data-spotlit'))).toEqual([
      'column',
      'column',
      'column',
    ]);
    const header = document.querySelector('[role="columnheader"][data-date="2026-10-05"]');
    expect(lit[0]).toBe(header);
    expect(scrollIntoView.mock.contexts[0]).toBe(header);
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

function floorDemand(date: string, shiftTypeId: string, rn: number): ShiftDemand {
  const role = (r: 'RN' | 'LPN' | 'CNA', minCount: number) => ({
    role: r,
    minCount,
    targetCount: minCount,
    coverageFloorMin: minCount,
    coverageFloorTarget: minCount,
    ratioDerived: 0,
    bindingConstraint: 'coverage_floor' as const,
  });
  return {
    date: isoDate(date),
    shiftTypeId,
    projectedCensus: 0,
    weightedCareHoursPerDay: 0,
    careHoursThisShift: 0,
    hppdRecommendedNurses: 0,
    careHoursRecommendedNurses: 0,
    byRole: { RN: role('RN', rn), LPN: role('LPN', 0), CNA: role('CNA', 0) },
    fromCoverageFloorOnly: true,
  } as ShiftDemand;
}

describe('the staffing summary under the grid', () => {
  beforeEach(() => localStorage.clear());

  // Monday needs one day RN and nobody is on; Tuesday needs one and Alice is on.
  function mountWithDemand() {
    return render(
      <ScheduleGrid
        nurses={[alice, ben]}
        shiftTypes={[DAY_12]}
        columns={COLUMNS}
        assignments={[assign(alice.id, DAY_12, '2026-10-06')]}
        pendingIds={new Set()}
        readOnly={false}
        violationsByAssignment={new Map()}
        violationsByNurse={new Map()}
        violationsByDate={new Map()}
        demand={[floorDemand('2026-10-05', DAY_12.id, 1), floorDemand('2026-10-06', DAY_12.id, 1)]}
        onMove={vi.fn()}
        onCreate={vi.fn()}
        onChipOpen={vi.fn()}
        onChipDelete={vi.fn()}
      />,
    );
  }

  it('says "1 short" on the day missing an RN and a tick on the fully staffed day', () => {
    mountWithDemand();
    const cells = within(screen.getByTestId('staffing-summary')).getAllByRole('gridcell');
    expect(cells.map((c) => c.textContent)).toEqual(['1 short', '✓']);
  });

  it('keeps the per-shift breakdown hidden until the manager opens it', () => {
    mountWithDemand();
    const toggle = screen.getByTestId('staffing-breakdown-toggle');
    expect(screen.queryAllByTestId('headcount-row')).toHaveLength(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(screen.getAllByTestId('headcount-row').length).toBeGreaterThan(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the breakdown again next time once the manager has left it open', () => {
    const first = mountWithDemand();
    fireEvent.click(screen.getByTestId('staffing-breakdown-toggle'));
    first.unmount();

    mountWithDemand();

    expect(screen.getByTestId('staffing-breakdown-toggle').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getAllByTestId('headcount-row').length).toBeGreaterThan(0);
  });

  it('still works when the browser will not let the app remember the choice', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    try {
      mountWithDemand();
      const toggle = screen.getByTestId('staffing-breakdown-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryAllByTestId('headcount-row')).toHaveLength(0);

      fireEvent.click(toggle);

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getAllByTestId('headcount-row').length).toBeGreaterThan(0);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('a held-over shift on the grid', () => {
  it('marks the chip with how long the nurse stayed and whether it was required', () => {
    renderGrid([
      { ...assign(alice.id, DAY_12, '2026-10-05'), holdoverMinutes: 90, holdoverMandated: true },
    ]);
    const chip = within(cell(alice, '2026-10-05')).getByTestId('assignment-chip');
    expect(within(chip).getByTestId('holdover-mark').textContent).toBe('+1h30m');
    expect(chip.getAttribute('title')).toContain('Held over 1h 30m (required)');
  });

  it('calls a volunteered holdover volunteered', () => {
    renderGrid([{ ...assign(alice.id, DAY_12, '2026-10-05'), holdoverMinutes: 45 }]);
    const chip = within(cell(alice, '2026-10-05')).getByTestId('assignment-chip');
    expect(chip.getAttribute('title')).toContain('Held over 45m (volunteered)');
  });
});
