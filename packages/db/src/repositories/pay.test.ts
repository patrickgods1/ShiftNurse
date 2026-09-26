/**
 * Repository tests for cost configuration: which pay rate is in force, and the rates,
 * differentials, overtime rules and budgets a manager edits.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, type IsoDate, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { ids } from '../ids.js';
import * as s from '../schema.js';
import { createShiftType, createUnit } from './config.js';
import {
  createDifferential,
  createOvertimeRule,
  createPayRate,
  deleteDifferential,
  deleteOvertimeRule,
  deletePayRate,
  effectiveRateForNurse,
  listActiveDifferentials,
  listActiveOvertimeRules,
  listDifferentialsForUnit,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
  updateDifferential,
  updateOvertimeRule,
  updatePayRate,
} from './pay.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let _shiftTypeId: string;
let _periodId: string;

function mkNurse(firstName: string): string {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: `E${Math.random().toString().slice(2, 8)}`,
      firstName,
      lastName: 'Nurse',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  ).id;
}

function insertPayRate(input: {
  nurseId?: string | null;
  role?: 'RN' | 'LPN' | 'CNA' | null;
  hourlyRate: number;
  effectiveFrom: IsoDate;
}): void {
  handle.db
    .insert(s.payRate)
    .values({
      id: ids.payRate(),
      nurseId: input.nurseId ?? null,
      role: input.role ?? null,
      hourlyRate: input.hourlyRate,
      effectiveFrom: input.effectiveFrom,
    })
    .run();
}

beforeEach(() => {
  handle = openTestDatabase();
  const unit = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  unitId = unit.id;
  _shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  const ruleSet = saveRuleSet(
    handle.db,
    {
      unitId,
      name: 'Default',
      weekendDefinition: {
        startWeekday: 6,
        startMinute: 0,
        durationMinutes: 2880,
        mode: 'starts_within',
      },
      fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
      configs: [
        {
          ruleId: 'min-rest-between-shifts',
          enabled: true,
          params: { minRestHours: 10, onCallCountsAsWork: false },
        },
      ],
    },
    ACTOR,
  );
  _periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Test Period',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('effective pay rate', () => {
  it('prefers a per-nurse rate over the role default', () => {
    const nurseId = mkNurse('Paid');
    insertPayRate({ role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ nurseId, hourlyRate: 52, effectiveFrom: isoDate('2025-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      52,
    );
  });

  it('picks the latest rate that is not after the query date', () => {
    const nurseId = mkNurse('Raised');
    insertPayRate({ nurseId, hourlyRate: 45, effectiveFrom: isoDate('2024-01-01') });
    insertPayRate({ nurseId, hourlyRate: 48, effectiveFrom: isoDate('2025-07-01') });
    insertPayRate({ nurseId, hourlyRate: 51, effectiveFrom: isoDate('2026-01-15') });

    // The day before the newest raise takes effect, the previous rate still applies.
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-14'))?.hourlyRate).toBe(
      48,
    );
    // On the effective date itself, the raise applies.
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      51,
    );
  });

  it('ignores a rate whose effective date is still in the future', () => {
    const nurseId = mkNurse('Future');
    insertPayRate({ nurseId, hourlyRate: 45, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ nurseId, hourlyRate: 60, effectiveFrom: isoDate('2027-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      45,
    );
  });

  it('falls back to the role default when the nurse has no rate of their own', () => {
    const nurseId = mkNurse('Default');
    insertPayRate({ role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ role: 'LPN', hourlyRate: 30, effectiveFrom: isoDate('2025-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      40,
    );
  });

  it('returns undefined when neither a nurse nor a role rate exists', () => {
    const nurseId = mkNurse('Unpriced');
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))).toBeUndefined();
  });
});

describe('cost configuration', () => {
  it('records a new pay rate with an audit entry and refuses one with no scope', () => {
    const nurseId = mkNurse('Raised');
    const rate = createPayRate(
      handle.db,
      { nurseId, role: null, hourlyRate: 52, effectiveFrom: isoDate('2026-02-01') },
      ACTOR,
    );
    expect(listPayRatesForUnit(handle.db, unitId)).toEqual([rate]);
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id)[0]).toMatchObject({
      action: 'create',
      after: rate,
    });

    expect(() =>
      createPayRate(
        handle.db,
        { nurseId: null, role: null, hourlyRate: 40, effectiveFrom: isoDate('2026-02-01') },
        ACTOR,
      ),
    ).toThrow(/nurse or a role/);
    expect(() =>
      createPayRate(
        handle.db,
        { nurseId, role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2026-02-01') },
        ACTOR,
      ),
    ).toThrow(/not both/);
  });

  it('corrects a mistyped rate in place, keeping the old value in the audit trail', () => {
    const rate = createPayRate(
      handle.db,
      { nurseId: null, role: 'RN', hourlyRate: 84, effectiveFrom: isoDate('2026-01-01') },
      ACTOR,
    );
    const fixed = updatePayRate(handle.db, rate.id, { hourlyRate: 48 }, ACTOR);
    expect(fixed).toEqual({ ...rate, hourlyRate: 48 });
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id)[0]).toMatchObject({
      action: 'update',
      before: rate,
      after: fixed,
    });
  });

  it('deletes a pay rate and audits what was removed', () => {
    const rate = createPayRate(
      handle.db,
      { nurseId: null, role: 'CNA', hourlyRate: 22, effectiveFrom: isoDate('2026-01-01') },
      ACTOR,
    );
    deletePayRate(handle.db, rate.id, ACTOR);
    expect(listPayRatesForUnit(handle.db, unitId)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id)[0]).toMatchObject({
      action: 'delete',
      before: rate,
    });
  });

  it('lists every differential for the unit but only active ones for pricing', () => {
    const night = createDifferential(
      handle.db,
      { unitId, kind: 'night', mode: 'flat', amount: 4.5, active: true },
      ACTOR,
    );
    const weekend = createDifferential(
      handle.db,
      { unitId, kind: 'weekend', mode: 'flat', amount: 3, active: true },
      ACTOR,
    );
    const paused = updateDifferential(handle.db, weekend.id, { active: false }, ACTOR);

    expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([night, paused]);
    expect(listActiveDifferentials(handle.db, unitId)).toEqual([night]);
    expect(auditHistoryFor(handle.db, 'differential', weekend.id)[0]).toMatchObject({
      action: 'update',
      before: weekend,
      after: paused,
    });

    deleteDifferential(handle.db, night.id, ACTOR);
    expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([paused]);
    expect(auditHistoryFor(handle.db, 'differential', night.id)[0]).toMatchObject({
      action: 'delete',
      before: night,
    });
  });

  it('manages overtime rules the same way', () => {
    const weekly = createOvertimeRule(
      handle.db,
      { unitId, basis: 'weekly', thresholdHours: 40, multiplier: 1.5, active: true },
      ACTOR,
    );
    const daily = createOvertimeRule(
      handle.db,
      { unitId, basis: 'daily', thresholdHours: 12, multiplier: 1.5, active: false },
      ACTOR,
    );
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([weekly, daily]);
    expect(listActiveOvertimeRules(handle.db, unitId)).toEqual([weekly]);

    const doubled = updateOvertimeRule(handle.db, daily.id, { multiplier: 2, active: true }, ACTOR);
    expect(listActiveOvertimeRules(handle.db, unitId)).toEqual([weekly, doubled]);
    expect(auditHistoryFor(handle.db, 'overtime_rule', daily.id)[0]).toMatchObject({
      action: 'update',
      before: daily,
      after: doubled,
    });

    deleteOvertimeRule(handle.db, weekly.id, ACTOR);
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([doubled]);
    expect(auditHistoryFor(handle.db, 'overtime_rule', weekly.id)[0]).toMatchObject({
      action: 'delete',
      before: weekly,
    });
  });

  it("does not list another unit's differentials or overtime rules", () => {
    const other = createUnit(
      handle.db,
      {
        name: 'ICU',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    createDifferential(
      handle.db,
      { unitId: other.id, kind: 'night', mode: 'flat', amount: 9, active: true },
      ACTOR,
    );
    createOvertimeRule(
      handle.db,
      { unitId: other.id, basis: 'daily', thresholdHours: 8, multiplier: 1.5, active: true },
      ACTOR,
    );
    expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([]);
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([]);
  });
});
