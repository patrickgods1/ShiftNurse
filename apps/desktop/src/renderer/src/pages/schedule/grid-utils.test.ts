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
import { headcountRows } from './grid-utils.js';

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
