import { describe, expect, it } from 'vitest';
import { compTimeCredit } from './comp-time.js';

describe('comp time earned in place of overtime pay', () => {
  it('banks 6 hours for 4 hours of overtime at time and a half when there is no cap', () => {
    // 4 overtime hours x 1.5 = 6 hours banked; nothing is left to pay in cash.
    expect(
      compTimeCredit({
        overtimeHours: 4,
        hoursPerOvertimeHour: 1.5,
        capHours: null,
        projectedBalanceHours: 100,
      }),
    ).toEqual({ creditedHours: 6, paidOvertimeHours: 0 });
  });

  it('banks only what fits under the 240-hour cap and pays the rest as overtime', () => {
    // Room = 240 - 237 = 3 hours. 4 x 1.5 = 6 would be banked, so 3 are: that covers
    // 3 / 1.5 = 2 overtime hours, and the other 4 - 2 = 2 are paid in cash.
    expect(
      compTimeCredit({
        overtimeHours: 4,
        hoursPerOvertimeHour: 1.5,
        capHours: 240,
        projectedBalanceHours: 237,
      }),
    ).toEqual({ creditedHours: 3, paidOvertimeHours: 2 });
  });

  it('pays all the overtime in cash when the balance is already past the cap', () => {
    // Room is 0, not negative: 245 over a 240 cap banks nothing and pays all 4 hours.
    expect(
      compTimeCredit({
        overtimeHours: 4,
        hoursPerOvertimeHour: 1.5,
        capHours: 240,
        projectedBalanceHours: 245,
      }),
    ).toEqual({ creditedHours: 0, paidOvertimeHours: 4 });
  });

  it('banks and pays nothing when no overtime was worked', () => {
    expect(
      compTimeCredit({
        overtimeHours: 0,
        hoursPerOvertimeHour: 1.5,
        capHours: 240,
        projectedBalanceHours: 10,
      }),
    ).toEqual({ creditedHours: 0, paidOvertimeHours: 0 });
  });

  it('refuses a rate of zero or less, and negative overtime', () => {
    const ok = { overtimeHours: 4, capHours: null, projectedBalanceHours: 0 };
    expect(() => compTimeCredit({ ...ok, hoursPerOvertimeHour: 0 })).toThrow(/rate/);
    expect(() => compTimeCredit({ ...ok, hoursPerOvertimeHour: -1.5 })).toThrow(/rate/);
    expect(() => compTimeCredit({ ...ok, overtimeHours: -1, hoursPerOvertimeHour: 1.5 })).toThrow(
      /overtime hours/i,
    );
  });
});
