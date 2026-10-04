import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { accruedHours, checkLeaveBalance, fmlaEligibility, fmlaRemaining } from './balances.js';

describe('accruing sick leave', () => {
  it('earns an hour for every 30 worked, as California’s minimum does', () => {
    // 216 hours (eighteen 12s) / 30 = 7.2 hours.
    expect(accruedHours(216, { hoursPerAccruedHour: 30 })).toBeCloseTo(7.2, 10);
  });

  it('stops at the cap the policy sets', () => {
    expect(accruedHours(3000, { hoursPerAccruedHour: 30, capHours: 80 }, 40)).toBe(40);
  });
});

describe('checking a request against the balance', () => {
  it('says a request fits when the balance covers its paid hours', () => {
    expect(checkLeaveBalance({ balanceHours: 40, requestHours: 36 })).toEqual({
      ok: true,
      remainingHours: 4,
    });
  });

  it('says how many hours short a request is', () => {
    expect(checkLeaveBalance({ balanceHours: 20, requestHours: 36 })).toEqual({
      ok: false,
      shortHours: 16,
      message: 'This request pays 36 hours; the balance is 20, 16 short.',
    });
  });
});

describe('FMLA', () => {
  it('gives a nurse on three 12s a week 432 hours, twelve of their weeks', () => {
    expect(fmlaRemaining({ weeklyHours: 36, usedHours: [], onDate: isoDate('2027-03-01') })).toBe(
      432,
    );
  });

  it('counts only leave in the twelve months back from the date, a rolling year', () => {
    const usedHours = [
      { date: isoDate('2026-02-28'), hours: 36 }, // 366 days before 1 Mar 2027: outside
      { date: isoDate('2026-03-02'), hours: 72 }, // inside
      { date: isoDate('2027-02-01'), hours: 12 }, // inside
    ];
    expect(fmlaRemaining({ weeklyHours: 36, usedHours, onDate: isoDate('2027-03-01') })).toBe(
      432 - 84,
    );
  });

  it('never goes below zero', () => {
    expect(
      fmlaRemaining({
        weeklyHours: 36,
        usedHours: [{ date: isoDate('2027-01-05'), hours: 500 }],
        onDate: isoDate('2027-03-01'),
      }),
    ).toBe(0);
  });

  it('needs a year on staff and 1,250 hours worked in it', () => {
    expect(
      fmlaEligibility({
        hiredOn: isoDate('2026-02-01'),
        onDate: isoDate('2027-03-01'),
        hoursLast12Months: 1300,
      }),
    ).toEqual({ eligible: true });
    expect(
      fmlaEligibility({
        hiredOn: isoDate('2026-06-01'),
        onDate: isoDate('2027-03-01'),
        hoursLast12Months: 1300,
      }),
    ).toEqual({
      eligible: false,
      reason: 'Employed 9 months; FMLA needs 12.',
    });
    expect(
      fmlaEligibility({
        hiredOn: isoDate('2020-01-01'),
        onDate: isoDate('2027-03-01'),
        hoursLast12Months: 1100,
      }),
    ).toEqual({
      eligible: false,
      reason: 'Worked 1,100 hours in the last 12 months; FMLA needs 1,250.',
    });
  });
});
