/**
 * Who goes home when the census drops, worked by hand. Day 12 on Tue 6 Jul 2027; seniority Ana
 * (2008), Bo (2012), Cy (2019), Di (2021).
 */

import { describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { assign, DAY_12, makeNurse } from '../testing/fixtures.js';
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
