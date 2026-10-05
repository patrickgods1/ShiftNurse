/**
 * Low-census cancellation records and the unit's order. The history feeds the rotation, so its
 * year window and its per-unit scoping are what keep one nurse from being sent home every quiet
 * Sunday; the policy refusals keep a typo from silently cancelling nobody.
 */

import { DEFAULT_CANCELLATION_TIERS, DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import {
  cancellationHistory,
  getCancellationPolicy,
  listShiftCancellationsForPeriod,
  recordShiftCancellation,
  saveCancellationPolicy,
} from './cancellations.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let shiftTypeId: string;
let periodId: string;

function mkUnit(name: string) {
  return createUnit(
    handle.db,
    {
      name,
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
}

function mkNurse(forUnit: string, firstName: string): string {
  return createNurse(
    handle.db,
    {
      unitId: forUnit,
      employeeId: nextEmployeeId(),
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

function cancel(nurseId: string, date: string, reason = 'Rotation: no cancellations yet.') {
  return recordShiftCancellation(
    handle.db,
    { periodId, nurseId, shiftTypeId, date: isoDate(date), reason },
    ACTOR,
  );
}

beforeEach(() => {
  handle = openTestDatabase();
  unitId = mkUnit('4 West').id;
  shiftTypeId = createShiftType(
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
  const ruleSet = transact(handle.db, (tx) =>
    saveRuleSet(
      tx,
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
        configs: [],
      },
      ACTOR,
    ),
  );
  periodId = createPeriod(
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

describe('the unit’s cancellation order', () => {
  it('starts as the contract’s usual order until the manager changes it', () => {
    expect(getCancellationPolicy(handle.db, unitId)).toEqual([...DEFAULT_CANCELLATION_TIERS]);
  });

  it('keeps a reordered policy and audits the change with what it was before', () => {
    saveCancellationPolicy(handle.db, unitId, ['rotation', 'volunteer'], ACTOR);
    const saved = saveCancellationPolicy(handle.db, unitId, ['volunteer', 'per_diem'], ACTOR);
    expect(saved).toEqual(['volunteer', 'per_diem']);
    expect(getCancellationPolicy(handle.db, unitId)).toEqual(['volunteer', 'per_diem']);
    const rows = handle.sqlite
      .prepare("select id from audit_log where entity_type = 'cancellation_policy' order by at")
      .all() as { id: string }[];
    expect(rows).toHaveLength(2);
    const policyId = (
      handle.sqlite.prepare('select id from cancellation_policy').get() as { id: string }
    ).id;
    const [update] = auditHistoryFor(handle.db, 'cancellation_policy', policyId);
    expect(update).toMatchObject({
      action: 'update',
      before: { tiers: ['rotation', 'volunteer'] },
      after: { tiers: ['volunteer', 'per_diem'] },
    });
  });

  it('refuses an order that lists a tier twice, names none, or invents one', () => {
    expect(() => saveCancellationPolicy(handle.db, unitId, ['agency', 'agency'], ACTOR)).toThrow(
      /only once/,
    );
    expect(() => saveCancellationPolicy(handle.db, unitId, [], ACTOR)).toThrow(/at least one tier/);
    expect(() => saveCancellationPolicy(handle.db, unitId, ['seniority' as never], ACTOR)).toThrow(
      /not a cancellation tier/,
    );
  });
});

describe('recording a nurse sent home', () => {
  it('stores the event with the order’s own reason and audits it', () => {
    const ada = mkNurse(unitId, 'Ada');
    const record = cancel(ada, '2026-01-20', 'Ada offered to go home.');
    expect(listShiftCancellationsForPeriod(handle.db, periodId)).toEqual([record]);
    expect(record).toMatchObject({ nurseId: ada, enteredBy: 'manager' });
    const [entry] = auditHistoryFor(handle.db, 'shift_cancellation', record.id);
    expect(entry).toMatchObject({
      action: 'create',
      reason: 'Ada offered to go home.',
      after: { nurseId: ada, date: '2026-01-20' },
    });
  });

  it('refuses a cancellation with no reason, and a nurse from another unit', () => {
    const ada = mkNurse(unitId, 'Ada');
    expect(() => cancel(ada, '2026-01-20', '   ')).toThrow(/needs a stated reason/);
    const stranger = mkNurse(mkUnit('Other').id, 'Zed');
    expect(() => cancel(stranger, '2026-01-20')).toThrow('That nurse is not on this unit');
    expect(listShiftCancellationsForPeriod(handle.db, periodId)).toEqual([]);
  });
});

describe('who has been cancelled in the last year', () => {
  it('counts each nurse’s cancellations and the latest date', () => {
    const ada = mkNurse(unitId, 'Ada');
    const bea = mkNurse(unitId, 'Bea');
    cancel(ada, '2026-01-16');
    cancel(ada, '2026-01-22');
    cancel(bea, '2026-01-18');
    const history = cancellationHistory(handle.db, unitId, isoDate('2026-02-01'));
    expect(history.get(ada)).toEqual({ count: 2, lastOn: '2026-01-22' });
    expect(history.get(bea)).toEqual({ count: 1, lastOn: '2026-01-18' });
  });

  it('leaves out a cancellation from more than a year back', () => {
    const ada = mkNurse(unitId, 'Ada');
    cancel(ada, '2026-01-16');
    // 2027-01-16 is exactly 365 days on (2026 is not a leap year): still counted. A day later is not.
    expect(cancellationHistory(handle.db, unitId, isoDate('2027-01-16')).get(ada)?.count).toBe(1);
    expect(cancellationHistory(handle.db, unitId, isoDate('2027-01-17')).get(ada)).toBeUndefined();
  });

  it('does not count another unit’s cancellations', () => {
    const ada = mkNurse(unitId, 'Ada');
    cancel(ada, '2026-01-16');
    const other = mkUnit('Other');
    expect(cancellationHistory(handle.db, other.id, isoDate('2026-02-01')).size).toBe(0);
  });
});
