import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a unit’s leave policy arriving over IPC', () => {
  const s = API_SCHEMAS.units;
  const policy = {
    fmla: { regime: 'title5', yearMethod: 'rolling_forward' },
    leaveYearStart: 'first_full_pay_period',
    accrual: [{ balanceType: 'annual', tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }] }],
  };

  it('accepts a policy, and null to go back to the default', () => {
    expect(s.update.safeParse(['u-1', { leavePolicy: policy }]).success).toBe(true);
    expect(s.update.safeParse(['u-1', { leavePolicy: null }]).success).toBe(true);
  });

  it('leaves a policy the validator would refuse to the validator, so its words reach the manager', () => {
    const noTiers = { ...policy, accrual: [{ balanceType: 'annual', tiers: [] }] };
    expect(s.update.safeParse(['u-1', { leavePolicy: noTiers }]).success).toBe(true);
  });

  it('refuses a regime that is neither Title I nor Title 5', () => {
    const bad = { ...policy, fmla: { regime: 'title9', yearMethod: 'calendar' } };
    expect(s.update.safeParse(['u-1', { leavePolicy: bad }]).success).toBe(false);
  });
});

describe('a nurse’s hire date arriving over IPC', () => {
  it('is cleared with null and refused when it is not a date', () => {
    const s = API_SCHEMAS.nurses;
    expect(s.update.safeParse(['n-1', { hireDate: null }]).success).toBe(true);
    expect(s.update.safeParse(['n-1', { hireDate: '2025-11-01' }]).success).toBe(true);
    expect(s.update.safeParse(['n-1', { hireDate: '2025-02-30' }]).success).toBe(false);
  });
});
