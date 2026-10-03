import { describe, expect, it } from 'vitest';
import type { TimeOffRequest } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { leaveHoursBetween, paidLeaveCredits, suggestedPaidLeaveHours } from './paid-leave.js';

const request = (over: Partial<TimeOffRequest>): TimeOffRequest => ({
  id: 'to1',
  nurseId: 'n1',
  startDate: isoDate('2026-10-05'),
  endDate: isoDate('2026-10-07'),
  type: 'pto',
  status: 'approved',
  enteredBy: 'manager',
  submittedAt: 0,
  ...over,
});

const TWELVES = [12];

describe('paidLeaveCredits', () => {
  it('pays three days off at 24 hours as two whole 12-hour shifts, not 8 hours a day', () => {
    expect(paidLeaveCredits([request({ paidHours: 24 })], [], TWELVES)).toEqual([
      { nurseId: 'n1', date: '2026-10-05', hours: 12 },
      { nurseId: 'n1', date: '2026-10-07', hours: 12 },
    ]);
  });

  it('keeps a week off paid at three shifts whole when it straddles two pay periods', () => {
    // Saturday Oct 31 to Friday Nov 6; the pay period turns over on Sunday Nov 1. Spread by
    // the day it put 5.1h in one period and 30.9h in the next — targets of 66.9h and 41.1h no
    // run of 12-hour shifts can meet, so the nurse read as short in the first.
    const credits = paidLeaveCredits(
      [
        request({
          startDate: isoDate('2026-10-31'),
          endDate: isoDate('2026-11-06'),
          paidHours: 36,
        }),
      ],
      [],
      TWELVES,
    );
    expect(leaveHoursBetween(credits, isoDate('2026-10-18'), isoDate('2026-10-31'))).toBe(0);
    expect(leaveHoursBetween(credits, isoDate('2026-11-01'), isoDate('2026-11-14'))).toBe(36);
    expect(credits.every((c) => c.hours === 12)).toBe(true);
  });

  it('pays a VA week of a 12 and an 8 as one of each', () => {
    const credits = paidLeaveCredits([request({ paidHours: 20 })], [], [12, 8]);
    expect(credits.map((c) => c.hours)).toEqual([12, 8]);
  });

  it('credits an odd remainder as one last part shift: 30 hours of 12s is 12, 12 and 6', () => {
    const credits = paidLeaveCredits([request({ paidHours: 30 })], [], TWELVES);
    expect(credits.map((c) => c.hours)).toEqual([12, 12, 6]);
  });

  it('credits nothing for a request that is pending, denied or unpaid', () => {
    expect(
      paidLeaveCredits([
        request({ paidHours: 24, status: 'pending' }),
        request({ paidHours: 24, status: 'denied' }),
        request({ type: 'unpaid', paidHours: 0 }),
        request({}),
      ]),
    ).toEqual([]);
  });

  it('credits a paid sick call on the day of the shift the nurse missed', () => {
    expect(
      paidLeaveCredits([], [{ nurseId: 'n2', date: isoDate('2026-10-09'), hours: 12 }]),
    ).toEqual([{ nurseId: 'n2', date: '2026-10-09', hours: 12 }]);
  });
});

describe('leaveHoursBetween', () => {
  it('splits leave that straddles a pay-period boundary by the shifts on each side', () => {
    // Saturday 3 to Monday 5 October, 36 paid hours: 12 fall before Sunday the 4th.
    const credits = paidLeaveCredits(
      [
        request({
          startDate: isoDate('2026-10-03'),
          endDate: isoDate('2026-10-05'),
          paidHours: 36,
        }),
      ],
      [],
      TWELVES,
    );
    expect(leaveHoursBetween(credits, isoDate('2026-09-20'), isoDate('2026-10-03'))).toBe(12);
    expect(leaveHoursBetween(credits, isoDate('2026-10-04'), isoDate('2026-10-17'))).toBe(24);
  });
});

describe('suggestedPaidLeaveHours', () => {
  const fullTime12 = { contractedHoursPerPeriod: 72, payPeriodDays: 14, shiftHours: 12 };

  it('charges one shift for a single day off', () => {
    expect(suggestedPaidLeaveHours({ ...fullTime12, type: 'pto', days: 1 })).toBe(12);
  });

  it('charges the three 12s a full-timer works in a week off, and six in a pay period', () => {
    expect(suggestedPaidLeaveHours({ ...fullTime12, type: 'pto', days: 7 })).toBe(36);
    expect(suggestedPaidLeaveHours({ ...fullTime12, type: 'pto', days: 14 })).toBe(72);
  });

  it('charges a VA full-timer five 8-hour tours for a week off', () => {
    expect(
      suggestedPaidLeaveHours({
        contractedHoursPerPeriod: 80,
        payPeriodDays: 14,
        shiftHours: 8,
        type: 'pto',
        days: 7,
      }),
    ).toBe(40);
  });

  it('suggests nothing for unpaid leave, FMLA or a per-diem nurse', () => {
    expect(suggestedPaidLeaveHours({ ...fullTime12, type: 'unpaid', days: 3 })).toBe(0);
    expect(suggestedPaidLeaveHours({ ...fullTime12, type: 'fmla', days: 3 })).toBe(0);
    expect(
      suggestedPaidLeaveHours({ ...fullTime12, contractedHoursPerPeriod: 0, type: 'pto', days: 3 }),
    ).toBe(0);
  });
});
