/**
 * Who floats to another unit, worked by hand. Seniority: Ana (2008), Bo (2012), Cy (2019),
 * Di (2021). The shift under test is Tue 6 Oct 2026; floats in the history fall on other dates
 * in 2026 (3 Mar was a Tuesday, 10 May a Sunday, 1 Apr a Wednesday).
 */

import { describe, expect, it } from 'vitest';
import type { FloatRecord, Preceptorship } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse } from '../testing/fixtures.js';
import { type FloatOrderInput, floatOrder } from './float-order.js';

const DATE = isoDate('2026-10-06');
const ana = makeNurse({
  id: 'ana',
  employeeId: 'E1',
  seniorityDate: isoDate('2008-03-01'),
  isChargeEligible: true,
});
const bo = makeNurse({ id: 'bo', employeeId: 'E2', seniorityDate: isoDate('2012-06-01') });
const cy = makeNurse({ id: 'cy', employeeId: 'E3', seniorityDate: isoDate('2019-09-01') });
const di = makeNurse({ id: 'di', employeeId: 'E4', seniorityDate: isoDate('2021-01-10') });

const on = (nurse: typeof ana, isCharge = false) => ({ nurse, isCharge });

function floated(nurseId: string, date: string, volunteered = false): FloatRecord {
  return {
    id: `f-${nurseId}-${date}`,
    unitId: 'unit-1',
    nurseId,
    date: isoDate(date),
    shiftTypeId: 'day',
    toUnit: '4B Telemetry',
    volunteered,
    actor: 'manager',
    at: 0,
  };
}

const input = (over: Partial<FloatOrderInput> = {}): FloatOrderInput => ({
  date: DATE,
  onShift: [on(ana, true), on(bo), on(cy), on(di)],
  volunteers: [],
  preceptorships: [],
  history: [],
  ...over,
});

const ids = (r: ReturnType<typeof floatOrder>) => r.order.map((p) => p.nurseId);

describe('floatOrder', () => {
  it('floats the volunteer before anyone in rotation', () => {
    const r = floatOrder(input({ volunteers: [bo.id] }));
    expect(ids(r)).toEqual(['bo', 'di', 'cy']);
    expect(r.order[0]).toMatchObject({ rank: 1, basis: 'volunteer', reason: 'Volunteered' });
    expect(r.order[1]).toMatchObject({ rank: 2, basis: 'rotation' });
  });

  it('takes volunteers in the order they offered', () => {
    expect(ids(floatOrder(input({ volunteers: [cy.id, bo.id] })))).toEqual(['cy', 'bo', 'di']);
  });

  it('never floats an orientee', () => {
    const preceptorship: Preceptorship = {
      id: 'pc-1',
      unitId: 'unit-1',
      orienteeId: 'di',
      preceptorId: 'bo',
      startDate: isoDate('2026-10-06'),
      endDate: isoDate('2026-12-01'),
    };
    // Even a volunteering orientee, on the first day of the orientation (inclusive).
    const r = floatOrder(input({ preceptorships: [preceptorship], volunteers: [di.id] }));
    expect(ids(r)).toEqual(['cy', 'bo']);
    expect(r.excluded).toContainEqual({
      nurseId: 'di',
      reason: 'In orientation; orientees are not floated',
    });
  });

  it('never floats an orientee on the last day of orientation', () => {
    const preceptorship: Preceptorship = {
      id: 'pc-1',
      unitId: 'unit-1',
      orienteeId: 'di',
      preceptorId: 'bo',
      startDate: isoDate('2026-08-01'),
      endDate: isoDate('2026-10-06'),
    };
    const r = floatOrder(input({ preceptorships: [preceptorship] }));
    expect(ids(r)).not.toContain('di');
    expect(r.excluded).toContainEqual({
      nurseId: 'di',
      reason: 'In orientation; orientees are not floated',
    });
  });

  it('floats an orientee again once the orientation has ended', () => {
    const preceptorship: Preceptorship = {
      id: 'pc-1',
      unitId: 'unit-1',
      orienteeId: 'di',
      preceptorId: 'bo',
      startDate: isoDate('2026-08-01'),
      endDate: isoDate('2026-10-05'),
    };
    expect(ids(floatOrder(input({ preceptorships: [preceptorship] })))).toContain('di');
  });

  it('rotates to the nurse floated fewest times this year', () => {
    const history = [
      floated('cy', '2026-03-03'),
      floated('cy', '2026-05-10'),
      floated('di', '2026-04-01'),
    ];
    // Bo has never floated, Di once, Cy twice.
    const r = floatOrder(input({ history }));
    expect(ids(r)).toEqual(['bo', 'di', 'cy']);
    expect(r.order[2]!.reason).toBe(
      'Rotation: floated 2 times in the last year, last on Sun May 10',
    );
    expect(r.order[1]!.reason).toBe('Rotation: floated 1 time in the last year, last on Wed Apr 1');
  });

  it('floats the nurse floated longest ago when the counts are level', () => {
    const history = [floated('bo', '2026-08-01'), floated('cy', '2026-02-01')];
    // Each of Bo and Cy was floated once. Di never was, so Di is first; then Cy (Feb) is
    // longer ago than Bo (Aug).
    expect(ids(floatOrder(input({ history })))).toEqual(['di', 'cy', 'bo']);
  });

  it('floats the most junior nurse when the rotation is even', () => {
    const r = floatOrder(input());
    expect(ids(r)).toEqual(['di', 'cy', 'bo']);
    expect(r.order[0]!.reason).toBe('Rotation: not floated in the last year; most junior');
  });

  it('breaks a tie of seniority by employee id', () => {
    const twin = makeNurse({ id: 'twin', employeeId: 'E0', seniorityDate: di.seniorityDate });
    expect(ids(floatOrder(input({ onShift: [on(di), on(twin)] })))).toEqual(['twin', 'di']);
  });

  it('does not count a volunteered float against the rotation', () => {
    // Di volunteered twice, Cy was mandated once: Di is still the one with no mandated floats.
    const history = [
      floated('di', '2026-02-01', true),
      floated('di', '2026-03-01', true),
      floated('cy', '2026-04-01'),
    ];
    expect(ids(floatOrder(input({ history })))).toEqual(['di', 'bo', 'cy']);
  });

  it('excludes the charge nurse and a nurse who is not float-eligible', () => {
    const fixed = makeNurse({ id: 'fx', employeeId: 'E9', isFloatEligible: false });
    const r = floatOrder(input({ onShift: [on(ana, true), on(bo), on(fixed)] }));
    expect(ids(r)).toEqual(['bo']);
    expect(r.excluded).toEqual([
      { nurseId: 'ana', reason: 'Charge nurse for the shift' },
      { nurseId: 'fx', reason: 'Not float-eligible' },
    ]);
  });
});
