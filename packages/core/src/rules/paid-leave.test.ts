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

describe('paidLeaveCredits', () => {
  it('spreads three days of PTO paid at 24 hours as 8 hours a day', () => {
    expect(paidLeaveCredits([request({ paidHours: 24 })])).toEqual([
      { nurseId: 'n1', date: '2026-10-05', hours: 8 },
      { nurseId: 'n1', date: '2026-10-06', hours: 8 },
      { nurseId: 'n1', date: '2026-10-07', hours: 8 },
    ]);
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
  it('splits leave that straddles a pay-period boundary by day', () => {
    // Saturday 3 to Monday 5 October, 36 paid hours: 12 fall before Sunday the 4th.
    const credits = paidLeaveCredits([
      request({ startDate: isoDate('2026-10-03'), endDate: isoDate('2026-10-05'), paidHours: 36 }),
    ]);
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
