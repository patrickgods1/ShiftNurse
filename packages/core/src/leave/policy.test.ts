import { describe, expect, it } from 'vitest';
import type { AccrualRule, LeavePolicy } from '../domain/entities.js';
import { validateLeavePolicy } from './policy.js';

const rule = (over: Partial<AccrualRule> = {}): AccrualRule => ({
  balanceType: 'annual',
  tiers: [
    { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
    { fromYearsOfService: 3, hoursPerPayPeriod: 6 },
  ],
  carryoverCapHours: 240,
  ...over,
});

const policy = (over: Partial<LeavePolicy> = {}): LeavePolicy => ({
  fmla: { regime: 'title5', yearMethod: 'rolling_forward' },
  leaveYearStart: 'first_full_pay_period',
  accrual: [rule()],
  ...over,
});

describe('refusing a leave policy a manager could not have meant', () => {
  it('accepts the federal policy: 4 hours a pay period rising to 6 after three years', () => {
    expect(() => validateLeavePolicy(policy())).not.toThrow();
  });

  it('accepts a policy with no accrual rules, where balances are whatever payroll says', () => {
    expect(() => validateLeavePolicy(policy({ accrual: [] }))).not.toThrow();
  });

  it('accepts a part-time tier earning one hour for every ten worked', () => {
    const r = rule({ tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 0.1 }] });
    expect(() => validateLeavePolicy(policy({ accrual: [r] }))).not.toThrow();
  });

  it('refuses a fixed FMLA year with no start date', () => {
    const p = policy({ fmla: { regime: 'title1', yearMethod: 'fixed' } });
    expect(() => validateLeavePolicy(p)).toThrow(/start date/i);
  });

  it('refuses a fixed FMLA year that starts on a day that is not a date', () => {
    for (const bad of ['13-01', '04-31', '10/01', '2026-10-01']) {
      const p = policy({ fmla: { regime: 'title1', yearMethod: 'fixed', fixedYearStart: bad } });
      expect(() => validateLeavePolicy(p), bad).toThrow(/MM-DD/);
    }
  });

  it('refuses a fixed FMLA year starting 29 February, which most years do not have', () => {
    const p = policy({ fmla: { regime: 'title1', yearMethod: 'fixed', fixedYearStart: '02-29' } });
    expect(() => validateLeavePolicy(p)).toThrow(/29 February/);
  });

  it('accepts a fiscal-year FMLA start of 10-01', () => {
    const p = policy({ fmla: { regime: 'title1', yearMethod: 'fixed', fixedYearStart: '10-01' } });
    expect(() => validateLeavePolicy(p)).not.toThrow();
  });

  it('refuses an accrual rule with no tiers', () => {
    expect(() => validateLeavePolicy(policy({ accrual: [rule({ tiers: [] })] }))).toThrow(
      /no earning rates/i,
    );
  });

  it('refuses tiers that do not start at zero years of service', () => {
    const r = rule({ tiers: [{ fromYearsOfService: 1, hoursPerPayPeriod: 4 }] });
    expect(() => validateLeavePolicy(policy({ accrual: [r] }))).toThrow(/start at 0 years/i);
  });

  it('refuses tiers out of order or repeated', () => {
    for (const second of [3, 5]) {
      const r = rule({
        tiers: [
          { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
          { fromYearsOfService: 5, hoursPerPayPeriod: 6 },
          { fromYearsOfService: second, hoursPerPayPeriod: 8 },
        ],
      });
      expect(() => validateLeavePolicy(policy({ accrual: [r] })), String(second)).toThrow(
        /ascending/i,
      );
    }
  });

  it('refuses a tier that earns by pay period and by hour worked at once', () => {
    const r = rule({
      tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 4, hoursPerAccruedHour: 0.1 }],
    });
    expect(() => validateLeavePolicy(policy({ accrual: [r] }))).toThrow(/not both/i);
  });

  it('refuses a tier that earns nothing', () => {
    const r = rule({ tiers: [{ fromYearsOfService: 0 }] });
    expect(() => validateLeavePolicy(policy({ accrual: [r] }))).toThrow(/either/i);
  });

  it('refuses zero, negative or non-numeric earning rates', () => {
    for (const rate of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = rule({ tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: rate }] });
      expect(() => validateLeavePolicy(policy({ accrual: [r] })), String(rate)).toThrow(
        /greater than zero/i,
      );
    }
  });

  it('refuses a carryover or balance cap of zero or less, but allows leaving them out', () => {
    expect(() =>
      validateLeavePolicy(policy({ accrual: [rule({ carryoverCapHours: 0 })] })),
    ).toThrow(/carryover/i);
    expect(() =>
      validateLeavePolicy(policy({ accrual: [rule({ balanceCapHours: -80 })] })),
    ).toThrow(/balance cap/i);
    expect(() =>
      validateLeavePolicy(
        policy({ accrual: [rule({ carryoverCapHours: undefined, balanceCapHours: undefined })] }),
      ),
    ).not.toThrow();
  });

  it('names which rule is wrong when a later one is', () => {
    const p = policy({ accrual: [rule(), rule({ balanceType: 'sick', tiers: [] })] });
    expect(() => validateLeavePolicy(p)).toThrow(/sick/i);
  });
});
