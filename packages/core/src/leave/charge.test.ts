import { describe, expect, it } from 'vitest';
import { leaveChargeHours } from './charge.js';

describe('leave charged to a 72/80 nurse', () => {
  it('charges 13⅓ hours of balance for one 12-hour tour off', () => {
    expect(leaveChargeHours('va_72_80', 12)).toBeCloseTo(13.333, 2);
  });

  it('charges 10 hours for 9 hours of absence', () => {
    expect(leaveChargeHours('va_72_80', 9)).toBe(10);
  });

  it('charges a standard nurse the hours she is off', () => {
    expect(leaveChargeHours(undefined, 12)).toBe(12);
    expect(leaveChargeHours('standard', 12)).toBe(12);
  });

  it('charges a Baylor nurse the hours she is off', () => {
    expect(leaveChargeHours('va_baylor', 12)).toBe(12);
  });
});
