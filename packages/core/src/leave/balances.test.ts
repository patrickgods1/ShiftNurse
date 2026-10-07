import { describe, expect, it } from 'vitest';
import { checkLeaveBalance, checkUseCap } from './balances.js';

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

describe('California’s yearly cap on using sick leave', () => {
  it('says a 16-hour request is 8 over when 32 of the 40 allowed this year are used', () => {
    // A sick rule of 1 h per 30 worked with a 40-hour use cap: 32 + 16 = 48, 8 past 40.
    expect(
      checkUseCap({ usedThisYearHours: 32, requestHours: 16, useCapHoursPerYear: 40 }),
    ).toEqual({ ok: false, overBy: 8 });
  });

  it('lets a request that reaches the cap exactly through', () => {
    expect(
      checkUseCap({ usedThisYearHours: 24, requestHours: 16, useCapHoursPerYear: 40 }),
    ).toEqual({ ok: true, overBy: 0 });
  });
});
