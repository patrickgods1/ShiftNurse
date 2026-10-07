import { describe, expect, it } from 'vitest';
import { checkLeaveBalance } from './balances.js';

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
