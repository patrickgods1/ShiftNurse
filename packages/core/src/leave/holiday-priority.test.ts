/**
 * Holiday request priority, worked by hand. Three RNs by seniority: Ana (2008), Bo (2015),
 * Cy (2019). Christmas 2025 is last year's occurrence of Christmas 2026; Thanksgiving likewise.
 */

import { describe, expect, it } from 'vitest';
import type { Holiday, Preference } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse, timeOff } from '../testing/fixtures.js';
import { holidayRequestPriority, holidayWorkPriority } from './holiday-priority.js';

const ana = makeNurse({ id: 'ana', employeeId: 'E1', seniorityDate: isoDate('2008-03-01') });
const bo = makeNurse({ id: 'bo', employeeId: 'E2', seniorityDate: isoDate('2015-06-01') });
const cy = makeNurse({ id: 'cy', employeeId: 'E3', seniorityDate: isoDate('2019-09-01') });
const NURSES = [cy, bo, ana];

const holiday = (id: string, date: string, name: string): Holiday => ({
  id,
  unitId: 'unit-1',
  date: isoDate(date),
  name,
  isMajor: true,
  pairedHolidayId: null,
});
const XMAS_25 = holiday('xmas25', '2025-12-25', 'Christmas Day');
const XMAS_26 = holiday('xmas26', '2026-12-25', 'Christmas Day');
const THANKS_25 = holiday('thanks25', '2025-11-27', 'Thanksgiving');
const THANKS_26 = holiday('thanks26', '2026-11-26', 'Thanksgiving');
const HOLIDAYS = [XMAS_25, XMAS_26, THANKS_25, THANKS_26];

const pending = (id: string, nurseId: string, start: string, end: string) =>
  timeOff(nurseId, start, end, { id, status: 'pending' });

describe('holiday request priority', () => {
  it('puts the nurse who worked Christmas last year ahead of a more senior nurse who had it off', () => {
    const claims = holidayRequestPriority({
      pending: [
        pending('r-ana', 'ana', '2026-12-25', '2026-12-25'),
        pending('r-bo', 'bo', '2026-12-24', '2026-12-26'),
      ],
      approved: [],
      nurses: NURSES,
      holidays: HOLIDAYS,
      holidayWork: [{ holidayId: 'xmas25', nurseId: 'bo' }],
    });
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.holidayId).toBe('xmas26');
    expect(claim.claimants.map((c) => [c.nurseId, c.rank, c.workedLastYear])).toEqual([
      ['bo', 1, true],
      ['ana', 2, false],
    ]);
    expect(claim.claimants[0]!.reason).toBe('Worked Christmas Day last year; seniority 2015-06-01');
    expect(claim.claimants[1]!.reason).toBe(
      'Had Christmas Day off last year; seniority 2008-03-01',
    );
  });

  it('falls back to seniority when neither worked it last year', () => {
    const claims = holidayRequestPriority({
      pending: [
        pending('r-cy', 'cy', '2026-12-25', '2026-12-25'),
        pending('r-bo', 'bo', '2026-12-25', '2026-12-25'),
      ],
      approved: [],
      nurses: NURSES,
      holidays: HOLIDAYS,
      holidayWork: [{ holidayId: 'xmas25', nurseId: 'ana' }],
    });
    expect(claims[0]!.claimants.map((c) => c.nurseId)).toEqual(['bo', 'cy']);
    expect(claims[0]!.claimants.map((c) => c.workedLastYear)).toEqual([false, false]);
  });

  it("ranks by seniority when the unit has no record of last year's holiday", () => {
    const claims = holidayRequestPriority({
      pending: [
        pending('r-cy', 'cy', '2026-12-25', '2026-12-25'),
        pending('r-ana', 'ana', '2026-12-25', '2026-12-25'),
      ],
      approved: [],
      nurses: NURSES,
      holidays: [XMAS_26],
      holidayWork: [],
    });
    const [first, second] = claims[0]!.claimants;
    expect([first!.nurseId, first!.workedLastYear]).toEqual(['ana', null]);
    expect([second!.nurseId, second!.workedLastYear]).toEqual(['cy', null]);
    expect(first!.reason).toBe("No record of last year's Christmas Day; seniority 2008-03-01");
  });

  it('lists a request spanning Thanksgiving and Christmas under both', () => {
    const claims = holidayRequestPriority({
      pending: [pending('r-ana', 'ana', '2026-11-20', '2026-12-30')],
      approved: [],
      nurses: NURSES,
      holidays: HOLIDAYS,
      holidayWork: [],
    });
    expect(claims.map((c) => [c.holidayId, c.date])).toEqual([
      ['thanks26', '2026-11-26'],
      ['xmas26', '2026-12-25'],
    ]);
    expect(claims.map((c) => c.claimants[0]!.requestId)).toEqual(['r-ana', 'r-ana']);
  });

  it('ignores holidays no pending request covers', () => {
    const claims = holidayRequestPriority({
      pending: [pending('r-ana', 'ana', '2026-12-26', '2026-12-30')],
      approved: [timeOff('bo', '2026-12-24', '2026-12-25', { id: 'a-bo' })],
      nurses: NURSES,
      holidays: HOLIDAYS,
      holidayWork: [],
    });
    expect(claims).toEqual([]);
  });

  it('shows who already has the holiday off', () => {
    const claims = holidayRequestPriority({
      pending: [pending('r-ana', 'ana', '2026-12-25', '2026-12-25')],
      approved: [
        timeOff('bo', '2026-12-24', '2026-12-25', { id: 'a-bo' }),
        timeOff('cy', '2026-12-26', '2026-12-27', { id: 'a-cy' }),
      ],
      nurses: NURSES,
      holidays: HOLIDAYS,
      holidayWork: [],
    });
    expect(claims[0]!.alreadyOff).toEqual(['bo']);
  });

  it('breaks a seniority tie by employee number', () => {
    const dee = makeNurse({ id: 'dee', employeeId: 'E0', seniorityDate: isoDate('2015-06-01') });
    const claims = holidayRequestPriority({
      pending: [
        pending('r-bo', 'bo', '2026-12-25', '2026-12-25'),
        pending('r-dee', 'dee', '2026-12-25', '2026-12-25'),
      ],
      approved: [],
      nurses: [bo, dee],
      holidays: HOLIDAYS,
      holidayWork: [],
    });
    expect(claims[0]!.claimants.map((c) => c.nurseId)).toEqual(['dee', 'bo']);
  });

  it('ranks employee E9 ahead of E10 for Christmas when they started the same day', () => {
    // Same start date, neither worked last year: 9 < 10, so E9 is senior. A string compare
    // would put "E10" first.
    const e9 = makeNurse({ id: 'e9', employeeId: 'E9', seniorityDate: isoDate('2015-01-01') });
    const e10 = makeNurse({ id: 'e10', employeeId: 'E10', seniorityDate: isoDate('2015-01-01') });
    const claims = holidayRequestPriority({
      pending: [
        pending('r-e10', 'e10', '2026-12-25', '2026-12-25'),
        pending('r-e9', 'e9', '2026-12-25', '2026-12-25'),
      ],
      approved: [],
      nurses: [e10, e9],
      holidays: HOLIDAYS,
      holidayWork: [],
    });
    expect(claims[0]!.claimants.map((c) => c.nurseId)).toEqual(['e9', 'e10']);
  });
});

describe('a nurse on the Baylor weekend plan', () => {
  it('ranks behind every other claimant, however senior and whoever worked it last year', () => {
    // Ana is the most senior and worked Christmas last year: first in line, but on the Baylor
    // plan she has no holiday entitlement (VA Handbook 5011).
    const baylorAna = { ...ana, scheduleKind: 'va_baylor' as const };
    const claims = holidayRequestPriority({
      pending: [
        pending('r-ana', 'ana', '2026-12-25', '2026-12-25'),
        pending('r-bo', 'bo', '2026-12-25', '2026-12-25'),
        pending('r-cy', 'cy', '2026-12-25', '2026-12-25'),
      ],
      approved: [],
      nurses: [cy, bo, baylorAna],
      holidays: HOLIDAYS,
      holidayWork: [{ holidayId: 'xmas25', nurseId: 'ana' }],
    });
    expect(claims[0]!.claimants.map((c) => [c.nurseId, c.rank])).toEqual([
      ['bo', 1],
      ['cy', 2],
      ['ana', 3],
    ]);
    expect(claims[0]!.claimants[2]!.reason).toBe(
      'On the Baylor weekend plan (38 U.S.C. § 7456): no holiday entitlement',
    );
  });
});

describe('nurses who want to work a holiday', () => {
  // Three volunteers for Christmas 2026 by seniority: Eve (2010), Fay (2015), Gus (2020). Two RNs
  // are needed, so Gus, the least senior, is the one volunteer the day has no room for.
  const eve = makeNurse({ id: 'eve', employeeId: 'E5', seniorityDate: isoDate('2010-01-15') });
  const fay = makeNurse({ id: 'fay', employeeId: 'E6', seniorityDate: isoDate('2015-01-15') });
  const gus = makeNurse({ id: 'gus', employeeId: 'E7', seniorityDate: isoDate('2020-01-15') });
  const wantsToWork = (nurseId: string, holidayId: string): Preference => ({
    id: `p-${nurseId}-${holidayId}`,
    nurseId,
    kind: 'holiday_appetite',
    holidayId,
    weight: 3,
  });

  it('puts the most senior volunteers first and marks the one past what the floor needs', () => {
    const claims = holidayWorkPriority({
      holidays: HOLIDAYS,
      nurses: [gus, eve, fay],
      preferences: [
        wantsToWork('gus', 'xmas26'),
        wantsToWork('fay', 'xmas26'),
        wantsToWork('eve', 'xmas26'),
      ],
      needed: new Map([['xmas26', { RN: 2 }]]),
    });
    expect(claims.map((c) => [c.holidayId, c.nurseId, c.role, c.rank, c.beyondNeed])).toEqual([
      ['xmas26', 'eve', 'RN', 1, false],
      ['xmas26', 'fay', 'RN', 2, false],
      ['xmas26', 'gus', 'RN', 3, true],
    ]);
    expect(claims.map((c) => c.reason)).toEqual([
      'most senior RN volunteer',
      'RN volunteer, 1 more senior',
      'RN volunteer, 2 more senior',
    ]);
  });

  it("measures each role's volunteers against what that role needs", () => {
    // The LPN is the most senior volunteer overall, but she is first of one LPN, not ahead of the
    // RNs. Two RNs and one LPN are needed, so rn1 (2015) and rn2 (2018) both fit and nobody is
    // surplus; pooled against the total, rn2 would have been pushed out by the LPN.
    const lpn = makeNurse({
      id: 'lpn',
      employeeId: 'E1',
      role: 'LPN',
      seniorityDate: isoDate('2005-01-15'),
    });
    const rn1 = makeNurse({ id: 'rn1', employeeId: 'E2', seniorityDate: isoDate('2015-01-15') });
    const rn2 = makeNurse({ id: 'rn2', employeeId: 'E3', seniorityDate: isoDate('2018-01-15') });
    const claims = holidayWorkPriority({
      holidays: HOLIDAYS,
      nurses: [lpn, rn2, rn1],
      preferences: [
        wantsToWork('lpn', 'xmas26'),
        wantsToWork('rn2', 'xmas26'),
        wantsToWork('rn1', 'xmas26'),
      ],
      needed: new Map([['xmas26', { RN: 2, LPN: 1 }]]),
    });
    expect(claims.map((c) => [c.nurseId, c.role, c.rank, c.beyondNeed])).toEqual([
      ['rn1', 'RN', 1, false],
      ['rn2', 'RN', 2, false],
      ['lpn', 'LPN', 1, false],
    ]);
  });

  it('does not mark a role surplus when the date states no need for it', () => {
    const lpn = makeNurse({ id: 'lpn', employeeId: 'E1', role: 'LPN' });
    const claims = holidayWorkPriority({
      holidays: HOLIDAYS,
      nurses: [lpn],
      preferences: [wantsToWork('lpn', 'xmas26')],
      needed: new Map([['xmas26', { RN: 0 }]]),
    });
    expect(claims.map((c) => c.beyondNeed)).toEqual([false]);

    // A stated need of none is different from no statement: she is past it.
    const none = holidayWorkPriority({
      holidays: HOLIDAYS,
      nurses: [lpn],
      preferences: [wantsToWork('lpn', 'xmas26')],
      needed: new Map([['xmas26', { LPN: 0 }]]),
    });
    expect(none.map((c) => c.beyondNeed)).toEqual([true]);
  });

  it('gives a Baylor-plan volunteer no claim, however senior', () => {
    const baylorEve = { ...eve, scheduleKind: 'va_baylor' as const };
    const claims = holidayWorkPriority({
      holidays: HOLIDAYS,
      nurses: [baylorEve, fay],
      preferences: [wantsToWork('eve', 'xmas26'), wantsToWork('fay', 'xmas26')],
    });
    expect(claims.map((c) => [c.nurseId, c.rank, c.reason])).toEqual([
      ['fay', 1, 'most senior RN volunteer'],
    ]);
  });

  it('gives a nurse who never asked to work it no claim', () => {
    const claims = holidayWorkPriority({
      holidays: HOLIDAYS,
      nurses: [eve, fay, gus],
      preferences: [
        wantsToWork('fay', 'xmas26'),
        { id: 'p-gus-w', nurseId: 'gus', kind: 'weekend_appetite', level: 1, weight: 3 },
      ],
    });
    expect(claims.map((c) => [c.holidayId, c.nurseId, c.beyondNeed])).toEqual([
      ['xmas26', 'fay', false],
    ]);
  });
});
