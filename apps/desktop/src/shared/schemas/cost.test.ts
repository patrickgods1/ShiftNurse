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

  it('accepts the UC consecutive-shift premium and refuses it with only its shifts', () => {
    const premium = {
      unitId: 'u-1',
      kind: 'consecutive_shift',
      mode: 'multiplier',
      amount: 1.5,
      active: true,
      consecutive: { afterShifts: 4, withinDays: 4 },
    };
    expect(costSchemas.createDifferential.safeParse([premium]).success).toBe(true);
    expect(
      costSchemas.createDifferential.safeParse([{ ...premium, consecutive: { afterShifts: 4 } }])
        .success,
    ).toBe(false);
    expect(
      costSchemas.updateDifferential.safeParse(['d-1', { consecutive: { withinDays: 4 } }]).success,
    ).toBe(false);
    expect(
      costSchemas.createDifferential.safeParse([
        { ...premium, consecutive: { afterShifts: 0, withinDays: 4 } },
      ]).success,
    ).toBe(false);
  });

  it('accepts the 2025–2030 tiers for 8s, 10s and 12s and refuses a fourth', () => {
    const tier = (fullShiftHours: number, n: number) => ({
      fullShiftHours,
      afterShifts: n,
      withinDays: n,
    });
    const premium = (tiers: unknown[]) => ({
      unitId: 'u-1',
      kind: 'consecutive_shift',
      mode: 'multiplier',
      amount: 1.5,
      active: true,
      consecutive: { afterShifts: 4, withinDays: 4, tiers },
    });
    const uc = [tier(8, 6), tier(10, 5), tier(12, 4)];
    expect(costSchemas.createDifferential.safeParse([premium(uc)]).success).toBe(true);
    expect(costSchemas.createDifferential.safeParse([premium([...uc, tier(9, 5)])]).success).toBe(
      false,
    );
    expect(costSchemas.createDifferential.safeParse([premium([])]).success).toBe(false);
    expect(
      costSchemas.createDifferential.safeParse([premium([{ ...tier(8, 6), extra: 1 }])]).success,
    ).toBe(false);
  });

  it('accepts the UC short-rest premium and refuses more than a day off or an unknown scope', () => {
    const premium = {
      unitId: 'u-1',
      kind: 'short_rest',
      mode: 'multiplier',
      amount: 1.5,
      active: true,
      shortRest: { minHoursOff: 6, scope: 'whole_shift' },
    };
    expect(costSchemas.createDifferential.safeParse([premium]).success).toBe(true);
    for (const shortRest of [
      { minHoursOff: 0, scope: 'whole_shift' },
      { minHoursOff: 25, scope: 'whole_shift' },
      { minHoursOff: 6, scope: 'sometimes' },
    ]) {
      expect(costSchemas.createDifferential.safeParse([{ ...premium, shortRest }]).success).toBe(
        false,
      );
    }
    expect(costSchemas.updateDifferential.safeParse(['d-1', { shortRest: null }]).success).toBe(
      true,
    );
  });

  it('refuses a multiplier below 1 at the door', () => {
    const holiday = { unitId: 'u', kind: 'holiday', mode: 'multiplier', amount: 0.5, active: true };
    const refused = costSchemas.createDifferential.safeParse([holiday]);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({
      path: [0, 'amount'],
      message: 'must be 1 or more for a multiplier',
    });
    expect(costSchemas.createDifferential.safeParse([{ ...holiday, mode: 'flat' }]).success).toBe(
      true,
    );
    expect(
      costSchemas.updateDifferential.safeParse([
        'd-1',
        { kind: 'holiday', mode: 'multiplier', amount: 0.5 },
      ]).success,
    ).toBe(false);
    // Without the mode the patch cannot be judged here; the repository reads the stored one.
    expect(costSchemas.updateDifferential.safeParse(['d-1', { amount: 0.5 }]).success).toBe(true);
  });

  it('lets on-call standby through at 15% of basic pay', () => {
    const standby = {
      unitId: 'u',
      kind: 'on_call',
      mode: 'multiplier',
      amount: 0.15,
      active: true,
    };
    expect(costSchemas.createDifferential.safeParse([standby]).success).toBe(true);
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

  it('accepts California’s seventh-day rules, the first paying from hour zero', () => {
    const first8 = {
      unitId: 'u-1',
      basis: 'seventh_day',
      thresholdHours: 0,
      multiplier: 1.5,
      active: true,
    };
    expect(costSchemas.createOvertimeRule.safeParse([first8]).success).toBe(true);
    expect(
      costSchemas.createOvertimeRule.safeParse([{ ...first8, thresholdHours: 8, multiplier: 2 }])
        .success,
    ).toBe(true);
    expect(
      costSchemas.createOvertimeRule.safeParse([{ ...first8, thresholdHours: -1 }]).success,
    ).toBe(false);
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

  it('accepts overtime beyond the scheduled tour and after eight consecutive hours', () => {
    for (const basis of ['beyond_scheduled_tour', 'consecutive']) {
      const rule = { unitId: 'u-1', basis, thresholdHours: 0, multiplier: 1.5, active: true };
      expect(costSchemas.createOvertimeRule.safeParse([rule]).success).toBe(true);
    }
    const unknown = {
      unitId: 'u-1',
      basis: 'lunar',
      thresholdHours: 8,
      multiplier: 1.5,
      active: true,
    };
    expect(costSchemas.createOvertimeRule.safeParse([unknown]).success).toBe(false);
  });

  it('accepts the Baylor plan’s overtime past 24 hours in the weekend', () => {
    const rule = {
      unitId: 'u-1',
      basis: 'weekend',
      thresholdHours: 24,
      multiplier: 1.5,
      active: true,
      minimumMinutes: 15,
      scheduleKinds: ['va_baylor'],
    };
    expect(costSchemas.createOvertimeRule.safeParse([rule]).success).toBe(true);
  });

  it('accepts a California extra-day rule that does not pyramid, and a VA 15-minute minimum', () => {
    const rule = {
      unitId: 'u-1',
      basis: 'beyond_scheduled_days',
      thresholdHours: 8,
      multiplier: 2,
      active: true,
      pyramiding: 'none',
      minimumMinutes: 15,
    };
    expect(costSchemas.createOvertimeRule.safeParse([rule]).success).toBe(true);
    expect(
      costSchemas.createOvertimeRule.safeParse([{ ...rule, minimumMinutes: -1 }]).success,
    ).toBe(false);
    expect(
      costSchemas.createOvertimeRule.safeParse([{ ...rule, pyramiding: 'maybe' }]).success,
    ).toBe(false);
    expect(
      costSchemas.updateOvertimeRule.safeParse(['r-1', { pyramiding: null, minimumMinutes: null }])
        .success,
    ).toBe(true);
  });

  it('accepts an overtime rule for one VA plan with a tour-day filter, and refuses an empty plan list', () => {
    const rule = {
      unitId: 'u-1',
      basis: 'daily',
      thresholdHours: 12,
      multiplier: 1.5,
      active: true,
      scheduleKinds: ['va_72_80'],
      tourDays: 'only',
    };
    expect(costSchemas.createOvertimeRule.safeParse([rule]).success).toBe(true);
    expect(costSchemas.createOvertimeRule.safeParse([{ ...rule, scheduleKinds: [] }]).success).toBe(
      false,
    );
    expect(costSchemas.createOvertimeRule.safeParse([{ ...rule, tourDays: 'some' }]).success).toBe(
      false,
    );
    expect(
      costSchemas.updateOvertimeRule.safeParse(['r-1', { scheduleKinds: null, tourDays: null }])
        .success,
    ).toBe(true);
  });

  it('needs the premium stacking and the holiday-pay choice whenever pay settings are saved', () => {
    const save = costSchemas.savePaySettings;
    const full = {
      callBackMinimumHours: 2,
      premiumStacking: 'additive',
      holidayPayCoversOvertime: true,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock',
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
    };
    expect(save.safeParse(['u-1', { callBackMinimumHours: 2 }]).success).toBe(false);
    expect(save.safeParse(['u-1', full]).success).toBe(true);
    expect(
      save.safeParse(['u-1', { callBackMinimumHours: 2, premiumStacking: 'additive' }]).success,
    ).toBe(false);
    expect(save.safeParse(['u-1', { ...full, premiumStacking: 'stacked' }]).success).toBe(false);
  });

  it('needs the week attribution whenever pay settings are saved', () => {
    const save = costSchemas.savePaySettings;
    const full = {
      callBackMinimumHours: 2,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
    };
    expect(save.safeParse(['u-1', full]).success).toBe(false);
    expect(save.safeParse(['u-1', { ...full, overtimeWindowAttribution: 'start' }]).success).toBe(
      true,
    );
    expect(save.safeParse(['u-1', { ...full, overtimeWindowAttribution: 'weekly' }]).success).toBe(
      false,
    );
  });

  it('needs the spring-forward and break-premium choices whenever pay settings are saved', () => {
    const save = costSchemas.savePaySettings;
    const full = {
      callBackMinimumHours: 2,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock',
      paySpringForwardAsScheduled: true,
      breakPremiumRate: 'regular',
    };
    expect(save.safeParse(['u-1', full]).success).toBe(true);
    const { paySpringForwardAsScheduled: _s, ...withoutSpring } = full;
    expect(save.safeParse(['u-1', withoutSpring]).success).toBe(false);
    const { breakPremiumRate: _b, ...withoutRate } = full;
    expect(save.safeParse(['u-1', withoutRate]).success).toBe(false);
    expect(save.safeParse(['u-1', { ...full, breakPremiumRate: 'overtime' }]).success).toBe(false);
  });

  it('needs a reporting-pay notice of 0 to 24 hours whenever pay settings are saved', () => {
    const save = costSchemas.savePaySettings;
    const full = {
      callBackMinimumHours: 2,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 0,
      overtimeWindowAttribution: 'clock',
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
    };
    expect(save.safeParse(['u-1', full]).success).toBe(true);
    expect(save.safeParse(['u-1', { ...full, reportingPayNoticeHours: 24 }]).success).toBe(true);
    expect(save.safeParse(['u-1', { ...full, reportingPayNoticeHours: 25 }]).success).toBe(false);
    expect(save.safeParse(['u-1', { ...full, reportingPayNoticeHours: -1 }]).success).toBe(false);
    const { reportingPayNoticeHours: _, ...withoutNotice } = full;
    expect(save.safeParse(['u-1', withoutNotice]).success).toBe(false);
  });

  it('accepts a budget of zero and refuses a negative one', () => {
    expect(costSchemas.setBudget.safeParse(['p-1', 0]).success).toBe(true);
    expect(costSchemas.setBudget.safeParse(['p-1', -100]).success).toBe(false);
  });

  it('takes only the period when removing a budget', () => {
    expect(costSchemas.clearBudget.safeParse(['p-1']).success).toBe(true);
    expect(costSchemas.clearBudget.safeParse(['p-1', 5]).success).toBe(false);
  });
});
