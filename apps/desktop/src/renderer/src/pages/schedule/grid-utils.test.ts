import type { Assignment, ShiftDemand } from '@shiftnurse/core';
import { isoDate } from '@shiftnurse/core';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
} from '@shiftnurse/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { headcountRows, monthSpans, staffingSummary } from './grid-utils.js';

beforeEach(() => resetFixtureCounters());

const MON = isoDate('2026-10-05');
const TUE = isoDate('2026-10-06');

function demand(date: string, shiftTypeId: string, rn: number, cna = 0): ShiftDemand {
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
    byRole: { RN: role('RN', rn), LPN: role('LPN', 0), CNA: role('CNA', cna) },
    fromCoverageFloorOnly: true,
  } as ShiftDemand;
}

describe('the headcount under the grid', () => {
  it('counts Monday day RNs against what the floor needs, and shows Tuesday short', () => {
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse({ role: 'CNA' })];
    const assignments: Assignment[] = [
      assign(a!.id, DAY_12, '2026-10-05'),
      assign(b!.id, DAY_12, '2026-10-05'),
      assign(c!.id, DAY_12, '2026-10-05'),
      assign(a!.id, DAY_12, '2026-10-06'),
    ];
    const rows = headcountRows({
      shiftTypes: [DAY_12, NIGHT_12],
      nurses: [a!, b!, c!],
      assignments,
      demand: [demand('2026-10-05', DAY_12.id, 2, 1), demand('2026-10-06', DAY_12.id, 2, 1)],
      dates: [MON, TUE],
    });
    expect(rows.map((r) => `${r.shiftType.abbreviation} ${r.role}`)).toEqual(['D12 RN', 'D12 CNA']);
    expect(rows[0]!.cells).toEqual([
      { date: MON, staffed: 2, required: 2 },
      { date: TUE, staffed: 1, required: 2 },
    ]);
    expect(rows[1]!.cells).toEqual([
      { date: MON, staffed: 1, required: 1 },
      { date: TUE, staffed: 0, required: 1 },
    ]);
  });

  it('leaves out on-call and any shift and role nobody needs or works', () => {
    const a = makeNurse();
    const rows = headcountRows({
      shiftTypes: [DAY_12, NIGHT_12, ON_CALL],
      nurses: [a],
      assignments: [assign(a.id, ON_CALL, '2026-10-05'), assign(a.id, NIGHT_12, '2026-10-06')],
      demand: [],
      dates: [MON, TUE],
    });
    expect(rows.map((r) => `${r.shiftType.abbreviation} ${r.role}`)).toEqual(['N12 RN']);
    expect(rows[0]!.cells[1]).toEqual({ date: TUE, staffed: 1, required: 0 });
  });
});

describe('the one-line staffing summary under the grid', () => {
  it('reads Monday as fully staffed and Tuesday as two short, naming who is missing', () => {
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse({ role: 'CNA' })];
    const rows = headcountRows({
      shiftTypes: [DAY_12, NIGHT_12],
      nurses: [a!, b!, c!],
      assignments: [
        assign(a!.id, DAY_12, '2026-10-05'),
        assign(b!.id, DAY_12, '2026-10-05'),
        assign(c!.id, DAY_12, '2026-10-05'),
        assign(a!.id, DAY_12, '2026-10-06'),
      ],
      demand: [demand('2026-10-05', DAY_12.id, 2, 1), demand('2026-10-06', DAY_12.id, 2, 1)],
      dates: [MON, TUE],
    });
    expect(staffingSummary(rows, [MON, TUE])).toEqual([
      { date: MON, short: 0, details: [] },
      { date: TUE, short: 2, details: ['D12 RN 1/2', 'D12 CNA 0/1'] },
    ]);
  });

  it('does not let an extra RN hide a missing CNA', () => {
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse()];
    const rows = headcountRows({
      shiftTypes: [DAY_12],
      nurses: [a!, b!, c!],
      assignments: [
        assign(a!.id, DAY_12, '2026-10-05'),
        assign(b!.id, DAY_12, '2026-10-05'),
        assign(c!.id, DAY_12, '2026-10-05'),
      ],
      demand: [demand('2026-10-05', DAY_12.id, 2, 1)],
      dates: [MON],
    });
    expect(staffingSummary(rows, [MON])).toEqual([
      { date: MON, short: 1, details: ['D12 CNA 0/1'] },
    ]);
  });
});

describe('the month band over the date row', () => {
  it('spans a schedule that runs from late October into November as two months', () => {
    const dates = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map(
      isoDate,
    );
    expect(monthSpans(dates)).toEqual([
      { label: 'October 2026', start: 0, count: 3 },
      { label: 'November 2026', start: 3, count: 2 },
    ]);
  });

  it('crosses a year end as two months, each naming its year', () => {
    expect(monthSpans([isoDate('2026-12-31'), isoDate('2027-01-01')])).toEqual([
      { label: 'December 2026', start: 0, count: 1 },
      { label: 'January 2027', start: 1, count: 1 },
    ]);
  });

  it('is empty for no dates', () => {
    expect(monthSpans([])).toEqual([]);
  });
});
