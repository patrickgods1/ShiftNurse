/**
 * A float nurse shared by two units. 5 West has them on a day 12 on Wed 7 Jan; this unit must
 * neither double-book them nor break their rest, and must count those hours toward their week.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ShiftType } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { encodeCpsat } from '../solver/cpsat/encode.js';
import { SolverModel } from '../solver/model.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
} from '../testing/fixtures.js';
import { busyElsewhere } from './elsewhere.js';

beforeEach(() => resetFixtureCounters());

// 5 West's own day 12, another unit's shift type.
const WEST_DAY: ShiftType = { ...DAY_12, id: 'west-d12', unitId: 'unit-west', name: 'Day 12' };

describe('a nurse who also works on another unit', () => {
  it('turns the other unit’s shifts into busy time this unit cannot staff', () => {
    const busy = busyElsewhere(
      [assign('flo', WEST_DAY, '2026-01-07', { id: 'w1', periodId: 'west-jan' })],
      [WEST_DAY],
      '5 West',
    );
    expect(busy.shiftTypes).toEqual([
      expect.objectContaining({
        id: 'elsewhere:west-d12',
        name: 'Day 12 on 5 West',
        active: false,
      }),
    ]);
    expect(busy.assignments).toEqual([
      expect.objectContaining({
        id: 'w1',
        nurseId: 'flo',
        shiftTypeId: 'elsewhere:west-d12',
        isLocked: true,
      }),
    ]);
  });

  /** Flo on this unit with eight colleagues, and on 5 West for the shifts given. */
  function model(westDates: string[]) {
    const flo = makeNurse({ id: 'flo', firstName: 'Flo', lastName: 'Diaz' });
    const others = Array.from({ length: 8 }, (_, i) =>
      makeNurse({ isChargeEligible: i % 2 === 0 }),
    );
    const busy = busyElsewhere(
      westDates.map((d, i) => assign('flo', WEST_DAY, d, { id: `w${i}`, periodId: 'west-jan' })),
      [WEST_DAY],
      '5 West',
    );
    const base = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [flo, ...others],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 2),
        ...coverageAllWeek(NIGHT_12, 'RN', 2),
      ],
    });
    const m = new SolverModel({
      ...base,
      shiftTypes: [...base.shiftTypes, ...busy.shiftTypes],
      priorAssignments: [...base.priorAssignments, ...busy.assignments],
    });
    const n = m.nurseIdx.get('flo')!;
    const can = (date: string, type: ShiftType) =>
      m.canAdd(n, m.make(n, m.shiftAt(m.dateIdx.get(isoDate(date))!, type)));
    return { can, m };
  }

  it('will not book them here on a day they work there, nor the night before it', () => {
    const busy = model(['2026-01-07']);
    expect(busy.can('2026-01-07', DAY_12)).toBe(false);
    // The night of the 6th ends at 07:00 as 5 West's day begins: no rest at all.
    expect(busy.can('2026-01-06', NIGHT_12)).toBe(false);
    const free = model([]);
    expect(free.can('2026-01-07', DAY_12)).toBe(true);
    expect(free.can('2026-01-06', NIGHT_12)).toBe(true);
  });

  it('counts their hours there toward the week here', () => {
    // Sun 4, Tue 6 and Thu 8 Jan on 5 West are 36 hours; a fourth 12 here is 48, past the 40-hour
    // overtime threshold, so it is refused without authorisation.
    const busy = model(['2026-01-04', '2026-01-06', '2026-01-08']);
    expect(busy.can('2026-01-10', DAY_12)).toBe(false);
    // The next week starts again from nothing.
    expect(busy.can('2026-01-12', DAY_12)).toBe(true);
    expect(model([]).can('2026-01-10', DAY_12)).toBe(true);
  });

  it('leaves the busy shift out of this unit’s schedule, coverage and staffing', () => {
    const { m } = model(['2026-01-07']);
    expect(m.shifts.some((s) => s.shiftType.id === 'elsewhere:west-d12' && s.solvable)).toBe(false);
    expect(m.assignments().some((a) => a.shiftTypeId === 'elsewhere:west-d12')).toBe(false);
  });

  it('is a constraint CP-SAT keeps too: their shifts here never land on the busy day', () => {
    const flo = makeNurse({ id: 'flo' });
    const others = Array.from({ length: 8 }, (_, i) =>
      makeNurse({ isChargeEligible: i % 2 === 0 }),
    );
    const busy = busyElsewhere(
      [assign('flo', WEST_DAY, '2026-01-07', { id: 'w1', periodId: 'west-jan' })],
      [WEST_DAY],
      '5 West',
    );
    const base = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [flo, ...others],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 2),
        ...coverageAllWeek(NIGHT_12, 'RN', 2),
      ],
    });
    const input = {
      ...base,
      shiftTypes: [...base.shiftTypes, ...busy.shiftTypes],
      priorAssignments: [...base.priorAssignments, ...busy.assignments],
    };
    const encoding = encodeCpsat(input);
    const onBusyDay = encoding.shiftVars.find(
      (sv) =>
        sv.nurseId === 'flo' &&
        sv.shift.date === '2026-01-07' &&
        sv.shift.shiftType.id === DAY_12.id,
    );
    // Either no variable at all, or one the model forbids: setting it breaks a constraint.
    if (onBusyDay) {
      const decisions = new Map<number, number>([[onBusyDay.variable, 1]]);
      expect(encoding.builder.evaluate(decisions, encoding.objectiveScale).violated).not.toEqual(
        [],
      );
    }
  });
});
