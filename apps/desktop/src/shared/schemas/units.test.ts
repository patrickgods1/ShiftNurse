import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';
import { unitInput } from './units.js';

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

describe('a unit’s per-diem commitment arriving over IPC', () => {
  const s = API_SCHEMAS.units;
  const patch = (perDiemCommitment: unknown) => s.update.safeParse(['u-1', { perDiemCommitment }]);

  it('accepts two weekend shifts and one holiday, zeros, and null to stop checking', () => {
    expect(patch({ weekendShiftsPer4Weeks: 2, holidayShiftsPerYear: 1 }).success).toBe(true);
    expect(patch({ weekendShiftsPer4Weeks: 0, holidayShiftsPerYear: 0 }).success).toBe(true);
    expect(patch(null).success).toBe(true);
  });

  it('refuses a negative or part-shift commitment', () => {
    expect(patch({ weekendShiftsPer4Weeks: -1, holidayShiftsPerYear: 1 }).success).toBe(false);
    expect(patch({ weekendShiftsPer4Weeks: 2, holidayShiftsPerYear: 1.5 }).success).toBe(false);
  });

  it('refuses a commitment missing one half', () => {
    expect(patch({ weekendShiftsPer4Weeks: 2 }).success).toBe(false);
    expect(patch({ holidayShiftsPerYear: 1 }).success).toBe(false);
  });
});

describe('a unit’s pay calendar arriving over IPC', () => {
  const unit = (payPeriodDays: number) => ({
    name: '4 West',
    unitType: 'Medical-Surgical',
    payPeriodDays,
    payPeriodAnchor: '2026-01-04',
  });

  it('refuses a billion-day pay period and accepts a fortnight', () => {
    expect(unitInput.safeParse(unit(1e9)).success).toBe(false);
    expect(unitInput.safeParse(unit(32)).success).toBe(false);
    expect(unitInput.safeParse(unit(14)).success).toBe(true);
  });
});

describe('asking which unit the app opens', () => {
  it('takes no arguments, and refuses one', () => {
    expect(API_SCHEMAS.units.home.safeParse([]).success).toBe(true);
    expect(API_SCHEMAS.units.home.safeParse(['x']).success).toBe(false);
  });
});
