import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

const nurse = {
  unitId: 'u-1',
  employeeId: 'SMOKE-1',
  firstName: 'Smoke',
  lastName: 'Test',
  role: 'RN',
  employmentType: 'per_diem',
  fte: 0.2,
  contractedHoursPerPeriod: 0,
  seniorityDate: '2026-01-05',
  isChargeEligible: false,
  isNovice: true,
  isFloatEligible: true,
  active: true,
};

describe('a nurse arriving over IPC', () => {
  it('accepts a per diem nurse with no contracted hours and no phone', () => {
    expect(API_SCHEMAS.nurses.create.safeParse([nurse]).success).toBe(true);
  });

  it('refuses an employment type the unit does not know', () => {
    expect(
      API_SCHEMAS.nurses.create.safeParse([{ ...nurse, employmentType: 'temp' }]).success,
    ).toBe(false);
  });

  it('lets an edit clear a phone number with null but never move the nurse to another unit', () => {
    const update = API_SCHEMAS.nurses.update;
    expect(update.safeParse(['n-1', { phone: null, fte: 0.9 }]).success).toBe(true);
    expect(update.safeParse(['n-1', { unitId: 'u-2' }]).success).toBe(false);
  });
});
