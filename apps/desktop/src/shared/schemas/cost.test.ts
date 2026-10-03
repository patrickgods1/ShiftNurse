/** Pay settings as Settings › Pay sends them (`renderer/src/api-cost.ts`). */

import { describe, expect, it } from 'vitest';
import { costSchemas } from './cost.js';

describe('pay settings arriving over IPC', () => {
  it('accepts a role default rate and a per-nurse rate', () => {
    const role = { nurseId: null, role: 'RN', hourlyRate: 52, effectiveFrom: '2026-01-01' };
    const nurse = { nurseId: 'n-1', role: null, hourlyRate: 61.25, effectiveFrom: '2026-07-01' };
    expect(costSchemas.createPayRate.safeParse([role]).success).toBe(true);
    expect(costSchemas.createPayRate.safeParse([nurse]).success).toBe(true);
  });

  it('accepts a night differential and a weekly overtime rule', () => {
    const differential = {
      unitId: 'u-1',
      kind: 'night',
      mode: 'flat',
      amount: 4.5,
      active: true,
    };
    const overtime = {
      unitId: 'u-1',
      basis: 'weekly',
      thresholdHours: 40,
      multiplier: 1.5,
      active: true,
    };
    expect(costSchemas.createDifferential.safeParse([differential]).success).toBe(true);
    expect(costSchemas.createOvertimeRule.safeParse([overtime]).success).toBe(true);
  });

  it('accepts an 8/80 overtime rule over a pay period', () => {
    const rule = {
      unitId: 'u-1',
      basis: 'pay_period',
      thresholdHours: 80,
      multiplier: 1.5,
      active: true,
    };
    expect(costSchemas.createOvertimeRule.safeParse([rule]).success).toBe(true);
  });

  it('refuses overtime that pays less than straight time', () => {
    const rule = {
      unitId: 'u-1',
      basis: 'daily',
      thresholdHours: 8,
      multiplier: 0.5,
      active: true,
    };
    expect(costSchemas.createOvertimeRule.safeParse([rule]).success).toBe(false);
  });

  it('accepts a budget of zero and refuses a negative one', () => {
    expect(costSchemas.setBudget.safeParse(['p-1', 0]).success).toBe(true);
    expect(costSchemas.setBudget.safeParse(['p-1', -100]).success).toBe(false);
  });
});
