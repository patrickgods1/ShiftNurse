import { describe, expect, it } from 'vitest';
import { leaveChargeHours } from './charge.js';

describe('leave charged to a 72/80 nurse', () => {
  it('charges 13⅓ hours of balance for one 12-hour tour off', () => {
    expect(leaveChargeHours('va_72_80', 'annual', 12)).toBeCloseTo(13.333, 2);
  });

  it('charges 10 hours for 9 hours of absence', () => {
    expect(leaveChargeHours('va_72_80', 'sick', 9)).toBe(10);
  });

  it('charges a standard nurse the hours she is off', () => {
    expect(leaveChargeHours(undefined, 'annual', 12)).toBe(12);
    expect(leaveChargeHours('standard', 'sick', 12)).toBe(12);
  });

  it('charges a Baylor nurse the hours she is off', () => {
    expect(leaveChargeHours('va_baylor', 'annual', 12)).toBe(12);
  });

  it('charges annual leave 10 hours for 9 of absence', () => {
    expect(leaveChargeHours('va_72_80', 'annual', 9)).toBe(10);
  });

  it('charges comp time hour for hour, since the statute names only sick and annual leave', () => {
    expect(leaveChargeHours('va_72_80', 'comp', 12)).toBe(12);
  });

  it('charges PTO hour for hour', () => {
    expect(leaveChargeHours('va_72_80', 'pto', 12)).toBe(12);
  });
});
