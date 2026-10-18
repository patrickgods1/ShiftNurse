/** The size and range caps on IPC input: each has a case just inside and one just outside. */

import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

// 2026-01-01 plus N days, by hand: 400 days on is 2027-02-05, 3660 days on is 2036-01-09 (3652 to 2036-01-01: leap 2028, 2032).
const START = '2026-01-01';
const READS = [
  {
    method: 'dayOf.callOffs',
    schema: API_SCHEMAS.dayOf.callOffs,
    call: (a: string, b: string) => ['u', a, b],
    max: '2027-02-05',
    over: '2027-02-06',
  },
  {
    method: 'dayOfPay.list',
    schema: API_SCHEMAS.dayOfPay.list,
    call: (a: string, b: string) => ['u', a, b],
    max: '2027-02-05',
    over: '2027-02-06',
  },
  {
    method: 'timeOff.listInRange',
    schema: API_SCHEMAS.timeOff.listInRange,
    call: (a: string, b: string) => ['u', a, b],
    max: '2027-02-05',
    over: '2027-02-06',
  },
  {
    // The dates sit at arguments 2 and 3 here, not 1 and 2.
    method: 'leaveBalances.checkRequest',
    schema: API_SCHEMAS.leaveBalances.checkRequest,
    call: (a: string, b: string) => ['n-1', 'pto', a, b, 8],
    max: '2027-02-05',
    over: '2027-02-06',
  },
  {
    method: 'nurseRecord.exportToFile',
    schema: API_SCHEMAS.nurseRecord.exportToFile,
    call: (a: string, b: string) => ['n-1', a, b, 'csv'],
    max: '2036-01-09',
    over: '2036-01-10',
  },
] as const;

describe.each(READS)('a read range on $method', ({ schema, call, max, over }) => {
  it('accepts the longest range the cap allows and a single day', () => {
    expect(schema.safeParse(call(START, max)).success).toBe(true);
    expect(schema.safeParse(call(START, START)).success).toBe(true);
  });

  it('refuses a range one day past the cap, in words', () => {
    const result = schema.safeParse(call(START, over));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('the range is longer than');
  });

  it('refuses a range that ends before it starts', () => {
    const result = schema.safeParse(call('2026-02-01', START));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('the range ends before it starts');
  });
});

describe('other size caps', () => {
  it('refuses a solver setting over 10 million iterations', () => {
    const save = (maxIterations: number) =>
      API_SCHEMAS.solverSettings.save.safeParse(['u', { solverId: 'hybrid', maxIterations }]);
    expect(save(10_000_000).success).toBe(true);
    expect(save(10_000_001).success).toBe(false);
  });

  it('refuses contracted hours over 744 a pay period', () => {
    const nurse = (contractedHoursPerPeriod: number) => ({
      unitId: 'u',
      employeeId: 'E1',
      firstName: 'Ana',
      lastName: 'Diaz',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod,
      seniorityDate: '2020-01-06',
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    });
    expect(API_SCHEMAS.nurses.create.safeParse([nurse(744)]).success).toBe(true);
    expect(API_SCHEMAS.nurses.create.safeParse([nurse(745)]).success).toBe(false);
  });

  it('refuses a unit name over 200 characters', () => {
    const unit = (n: string) => ({
      name: n,
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: '2026-01-04',
    });
    const create = API_SCHEMAS.setup.createUnit;
    expect(create.safeParse([unit('x'.repeat(200)), 'assisted']).success).toBe(true);
    expect(create.safeParse([unit('x'.repeat(201)), 'assisted']).success).toBe(false);
  });

  it('refuses a seasonal window over 104 weeks and a part-week lookback', () => {
    const propose = (o: object) =>
      API_SCHEMAS.census.propose.safeParse(['u', '2026-10-04', '2026-10-11', o]).success;
    expect(propose({ seasonalWindowWeeks: 104 })).toBe(true);
    expect(propose({ seasonalWindowWeeks: 105 })).toBe(false);
    expect(propose({ lookbackWeeks: 104 })).toBe(true);
    expect(propose({ lookbackWeeks: 8.5 })).toBe(false);
  });

  it('refuses a weekend that lasts zero minutes', () => {
    const weights = {
      nights: 1,
      weekends: 1,
      holidays: 1,
      onCall: 1,
      undesirable: 1,
      overtime: 1,
      preferences: 1,
      timeOff: 1,
    };
    const save = (durationMinutes: number) =>
      API_SCHEMAS.rules.save.safeParse([
        'u',
        'x',
        [],
        { startWeekday: 6, startMinute: 0, durationMinutes, mode: 'starts_within' },
        weights,
      ]).success;
    expect(save(0)).toBe(false);
    expect(save(1)).toBe(true);
  });
});
