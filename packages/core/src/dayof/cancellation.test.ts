/**
 * Who goes home when the census drops, worked by hand. Day 12 on Tue 6 Jul 2027; seniority Ana
 * (2008), Bo (2012), Cy (2019), Di (2021).
 */

import { describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { assign, DAY_12, makeNurse, UNIT_ID } from '../testing/fixtures.js';
import {
  type CancellationHistory,
  cancellationOrder,
  DEFAULT_CANCELLATION_TIERS,
} from './cancellation.js';

const DATE = isoDate('2027-07-06');
const ana = makeNurse({
  id: 'ana',
  firstName: 'Ana',
  lastName: 'Cruz',
  employeeId: 'E1',
  seniorityDate: isoDate('2008-03-01'),
  isChargeEligible: true,
});
const bo = makeNurse({
  id: 'bo',
  firstName: 'Bo',
  lastName: 'Li',
  employeeId: 'E2',
  seniorityDate: isoDate('2012-06-01'),
});
const cy = makeNurse({
  id: 'cy',
  firstName: 'Cy',
  lastName: 'Ng',
  employeeId: 'E3',
  seniorityDate: isoDate('2019-09-01'),
});
const di = makeNurse({
  id: 'di',
  firstName: 'Di',
  lastName: 'Ota',
  employeeId: 'E4',
  seniorityDate: isoDate('2021-01-10'),
});
const agent = makeNurse({
  id: 'ag',
  firstName: 'Eve',
  lastName: 'Park',
  employeeId: 'A1',
  employmentType: 'agency',
  seniorityDate: isoDate('2026-01-01'),
});
const perDiem = makeNurse({
  id: 'pd',
  firstName: 'Fay',
  lastName: 'Ruiz',
  employeeId: 'P1',
  employmentType: 'per_diem',
  seniorityDate: isoDate('2015-01-01'),
});

function onShift(nurses: Nurse[], extra: Record<string, Partial<Assignment>> = {}) {
  return nurses.map((nurse) => ({
    nurse,
    assignment: assign(nurse.id, DAY_12, DATE, { id: `a-${nurse.id}`, ...extra[nurse.id] }),
  }));
}

function order(
  nurses: Nurse[],
  options: {
    extra?: Record<string, Partial<Assignment>>;
    volunteers?: string[];
    history?: CancellationHistory;
  } = {},
) {
  return cancellationOrder({
    unitId: UNIT_ID,
    onShift: onShift(nurses, options.extra),
    tiers: DEFAULT_CANCELLATION_TIERS,
    volunteers: options.volunteers ?? [],
    history: options.history ?? new Map(),
  });
}

describe('who goes home first when the census drops', () => {
  it('asks volunteers first, then agency, overtime and per diem, before staff by rotation', () => {
    const result = order([ana, bo, cy, agent, perDiem], {
      extra: { bo: { isOvertime: true }, ana: { isCharge: true } },
      volunteers: ['cy'],
    });
    expect(result.order.map((o) => `${o.nurseId}:${o.tier}`)).toEqual([
      'cy:volunteer',
      'ag:agency',
      'bo:overtime',
      'pd:per_diem',
    ]);
    expect(result.excluded).toEqual([
      { nurseId: 'ana', reason: 'Ana Cruz is the charge nurse on this shift.' },
    ]);
  });

  it('takes the staff nurse with the fewest cancellations so far, then the most junior', () => {
    const history: CancellationHistory = new Map([
      ['bo', { count: 2, lastOn: isoDate('2027-05-02') }],
      ['cy', { count: 1, lastOn: isoDate('2027-06-20') }],
    ]);
    const result = order([ana, bo, cy, di], { history });
    // Ana and Di have none; Di is junior. Then Cy (1), then Bo (2).
    expect(result.order.map((o) => o.nurseId)).toEqual(['di', 'ana', 'cy', 'bo']);
    expect(result.order[0]!.reason).toBe(
      'Rotation: no low-census cancellations yet, the fewest on this shift, and junior to Ana Cruz.',
    );
    expect(result.order[2]!.reason).toBe(
      'Rotation: 1 low-census cancellation, last on Sun Jun 20.',
    );
  });

  it('between equal counts, takes whoever was cancelled longest ago', () => {
    const history: CancellationHistory = new Map([
      ['bo', { count: 1, lastOn: isoDate('2027-06-30') }],
      ['cy', { count: 1, lastOn: isoDate('2027-04-11') }],
    ]);
    expect(order([bo, cy], { history }).order.map((o) => o.nurseId)).toEqual(['cy', 'bo']);
  });

  it('serves volunteers in the order they spoke up', () => {
    const result = order([ana, bo, cy], { volunteers: ['bo', 'cy'] });
    expect(result.order.slice(0, 2).map((o) => o.nurseId)).toEqual(['bo', 'cy']);
  });

  it('follows the unit’s own order of tiers', () => {
    const result = cancellationOrder({
      unitId: UNIT_ID,
      onShift: onShift([bo, agent, perDiem]),
      tiers: ['per_diem', 'agency', 'rotation'],
      volunteers: [],
      history: new Map(),
    });
    expect(result.order.map((o) => o.nurseId)).toEqual(['pd', 'ag', 'bo']);
  });

  it('never puts a nurse in two places', () => {
    // Agency and on overtime: listed once, in the first tier that takes them.
    const result = order([agent, bo], { extra: { ag: { isOvertime: true } }, volunteers: ['ag'] });
    expect(result.order.map((o) => `${o.nurseId}:${o.tier}`)).toEqual([
      'ag:volunteer',
      'bo:rotation',
    ]);
  });
});

/**
 * 4 West borrows Fran from 5 West and Gus from 6 West for the day. Ana is 4 West's own; nobody is
 * in charge. Ali is agency, booked on 4 West. Seniority: Fran (2001), Ana (2008), Gus (2016), Ali
 * (2026). Fran is senior to Ana on purpose, so a rotation alone would keep Fran and send Ana home
 * first; only the float tier puts Fran ahead of her.
 */
describe('a nurse floated in from another unit when the census drops', () => {
  const WEST_4 = 'u-4w';
  const ana4w = makeNurse({
    id: 'ana',
    unitId: WEST_4,
    firstName: 'Ana',
    lastName: 'Cruz',
    employeeId: 'E1',
    seniorityDate: isoDate('2008-03-01'),
  });
  const fran = makeNurse({
    id: 'fran',
    unitId: 'u-5w',
    firstName: 'Fran',
    lastName: 'Hale',
    employeeId: 'E9',
    seniorityDate: isoDate('2001-02-01'),
  });
  const gus = makeNurse({
    id: 'gus',
    unitId: 'u-6w',
    firstName: 'Gus',
    lastName: 'Lund',
    employeeId: 'E10',
    seniorityDate: isoDate('2016-05-01'),
  });
  const ali = makeNurse({
    id: 'ali',
    unitId: WEST_4,
    firstName: 'Ali',
    lastName: 'Shah',
    employeeId: 'A2',
    employmentType: 'agency',
    seniorityDate: isoDate('2026-02-01'),
  });

  function westOrder(
    nurses: Nurse[],
    options: {
      tiers?: Parameters<typeof cancellationOrder>[0]['tiers'];
      extra?: Record<string, Partial<Assignment>>;
      history?: CancellationHistory;
    } = {},
  ) {
    return cancellationOrder({
      unitId: WEST_4,
      onShift: onShift(nurses, options.extra),
      tiers: options.tiers ?? DEFAULT_CANCELLATION_TIERS,
      volunteers: [],
      history: options.history ?? new Map(),
    });
  }

  it('sends a nurse floated in home before the unit’s own staff', () => {
    const result = westOrder([ana4w, fran]);
    // No volunteers, no agency; the float tier takes Fran, then rotation takes Ana. A rotation
    // alone would have sent Ana (junior) first.
    expect(result.order.map((p) => p.nurseId)).toEqual(['fran', 'ana']);
    expect(result.order[0]!.tier).toBe('float');
    expect(result.order[0]!.reason).toBe(
      'Floated in from another unit; floated-in nurses go back before the unit’s own staff.',
    );
  });

  it('still cancels agency staff before a float', () => {
    const result = westOrder([ana4w, fran, ali, gus]);
    // Agency takes Ali; the float tier takes Gus (2016) before the senior Fran (2001); rotation
    // takes Ana. Without the float tier it would be Ali, Gus, Ana, Fran.
    expect(result.order.map((p) => `${p.nurseId}:${p.tier}`)).toEqual([
      'ali:agency',
      'gus:float',
      'fran:float',
      'ana:rotation',
    ]);
  });

  it('keeps the old order for a unit whose saved order leaves out the float tier', () => {
    const tiers = ['volunteer', 'agency', 'overtime', 'per_diem', 'rotation'] as const;
    const first = westOrder([ana4w, fran], {
      tiers,
      history: new Map([['ana', { count: 2 }]]),
    });
    // Rotation: Fran has none, Ana has 2.
    expect(first.order.map((p) => p.nurseId)).toEqual(['fran', 'ana']);
    expect(first.order[0]!.tier).toBe('rotation');

    const second = westOrder([ana4w, fran], {
      tiers,
      history: new Map([
        ['ana', { count: 2 }],
        ['fran', { count: 3 }],
      ]),
    });
    expect(second.order.map((p) => p.nurseId)).toEqual(['ana', 'fran']);
  });

  it('never sends home the charge nurse, even a float in charge', () => {
    const result = westOrder([ana4w, fran], { extra: { fran: { isCharge: true } } });
    expect(result.order.map((p) => p.nurseId)).toEqual(['ana']);
    expect(result.excluded).toEqual([
      { nurseId: 'fran', reason: 'Fran Hale is the charge nurse on this shift.' },
    ]);
  });
});
