/**
 * Competing time-off priority, worked by hand for Saturday 10 January 2026.
 * Ana: 1 approved, 3 denied = 25%. Ben: 3 approved, 1 denied = 75%. Cho: nothing decided.
 */

import { describe, expect, it } from 'vitest';
import type { FairnessLedgerEntry, Holiday } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse, timeOff } from '../testing/fixtures.js';
import { competingRequestPriority } from './request-priority.js';

const SAT = isoDate('2026-01-10');
const ana = makeNurse({ id: 'ana', employeeId: 'E1', seniorityDate: isoDate('2020-01-01') });
const ben = makeNurse({ id: 'ben', employeeId: 'E2', seniorityDate: isoDate('2015-01-01') });
const cho = makeNurse({ id: 'cho', employeeId: 'E3', seniorityDate: isoDate('2010-01-01') });

const row = (
  nurseId: string,
  approved: number,
  denied: number,
  id = nurseId,
): FairnessLedgerEntry => ({
  id: `l-${id}`,
  nurseId,
  periodId: `p-${id}`,
  periodStart: isoDate('2025-06-01'),
  nightShifts: 0,
  weekendsWorked: 0,
  holidaysWorked: 0,
  onCallShifts: 0,
  undesirableShifts: 0,
  requestsApproved: approved,
  requestsDenied: denied,
  callOutsCovered: 0,
  totalHours: 0,
  overtimeHours: 0,
  preferenceHitRate: 1,
});

const ask = (nurseId: string, submittedAt?: number) =>
  timeOff(nurseId, SAT, SAT, {
    id: `r-${nurseId}`,
    status: 'pending',
    ...(submittedAt === undefined ? {} : { submittedAt }),
  });

const base = { date: SAT, holidays: [], holidayWork: [] };

describe('who should get a contested day off first', () => {
  it('puts the nurse who is always denied first, and a nurse never denied last', () => {
    const out = competingRequestPriority({
      ...base,
      requests: [ask('cho'), ask('ben'), ask('ana')],
      nurses: [cho, ben, ana],
      ledger: [row('ana', 1, 3), row('ben', 3, 1)],
    });
    expect(out.map((c) => [c.nurseId, c.rank, c.approvalRate])).toEqual([
      ['ana', 1, 0.25],
      ['ben', 2, 0.75],
      ['cho', 3, null],
    ]);
    expect(out[0]!.reason).toBe('Approved 1 of 4 requests (25%); seniority 2020-01-01');
    expect(out[2]!.reason).toBe('No decided requests on record; seniority 2010-01-01');
    expect(out[0]!.workedHolidayLastYear).toBeNull();
  });

  it('sums a nurse approval record over every period on file', () => {
    const out = competingRequestPriority({
      ...base,
      requests: [ask('ana'), ask('ben')],
      nurses: [ana, ben],
      // Ana: 2 of 4 = 50% across two periods; Ben: 3 of 4 = 75%.
      ledger: [row('ana', 1, 1, 'a1'), row('ana', 1, 1, 'a2'), row('ben', 3, 1)],
    });
    expect(out.map((c) => c.nurseId)).toEqual(['ana', 'ben']);
    expect(out[0]!.approvalRate).toBe(0.5);
  });

  it('puts the nurse who worked the holiday last year first when approval rates are equal', () => {
    const winter = (id: string, date: string): Holiday => ({
      id,
      unitId: 'unit-1',
      date: isoDate(date),
      name: 'Winter Holiday',
      isMajor: true,
      pairedHolidayId: null,
    });
    const out = competingRequestPriority({
      requests: [ask('ana'), ask('ben')],
      date: SAT,
      nurses: [ana, ben],
      ledger: [row('ana', 2, 2), row('ben', 2, 2)],
      holidays: [winter('w25', '2025-01-11'), winter('w26', '2026-01-10')],
      holidayWork: [{ holidayId: 'w25', nurseId: 'ben' }],
    });
    // Ana is junior to Ben as well, so seniority alone would not separate this from the rule.
    expect(out.map((c) => [c.nurseId, c.workedHolidayLastYear])).toEqual([
      ['ben', true],
      ['ana', false],
    ]);
    expect(out[0]!.reason).toBe(
      'Approved 2 of 4 requests (50%); seniority 2015-01-01; worked Winter Holiday last year',
    );
  });

  it('puts the more senior nurse first when everything else is equal', () => {
    const out = competingRequestPriority({
      ...base,
      requests: [ask('ana'), ask('ben')],
      nurses: [ana, ben],
      ledger: [],
    });
    expect(out.map((c) => c.nurseId)).toEqual(['ben', 'ana']);
  });

  it('puts the earlier request first when nurses are otherwise tied', () => {
    const twin = makeNurse({ id: 'twin', employeeId: 'E9', seniorityDate: ana.seniorityDate });
    const out = competingRequestPriority({
      ...base,
      requests: [ask('twin', 2000), ask('ana', 1000)],
      nurses: [ana, twin],
      ledger: [],
    });
    expect(out.map((c) => c.nurseId)).toEqual(['ana', 'twin']);
    const flipped = competingRequestPriority({
      ...base,
      requests: [ask('twin', 1000), ask('ana', 2000)],
      nurses: [ana, twin],
      ledger: [],
    });
    expect(flipped.map((c) => c.nurseId)).toEqual(['twin', 'ana']);
  });

  it('refuses a request from a nurse the unit does not have', () => {
    expect(() =>
      competingRequestPriority({ ...base, requests: [ask('ghost')], nurses: [ana], ledger: [] }),
    ).toThrow(/ghost/);
  });
});
