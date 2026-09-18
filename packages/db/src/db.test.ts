/**
 * Integration tests for the persistence layer.
 *
 * These run against a real in-memory SQLite database with the real generated migrations —
 * not a mock and not a hand-built schema. That is deliberate: a test that builds its own
 * tables can pass while the migrations are broken, which is the one failure mode that would
 * reach a user as "the app won't start".
 */

import { isoDate } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recordAudit, recordAuditStrict } from './audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from './client.js';
import { ids } from './ids.js';
import { fromPreference, toNurse, toPreference, toTimeOffRequest } from './mappers.js';
import * as s from './schema.js';

let handle: OpenedDatabase;

beforeEach(() => {
  handle = openTestDatabase();
});

afterEach(() => {
  handle.close();
});

const UNIT_ID = 'unit-test';

function seedUnit(): void {
  handle.db
    .insert(s.unit)
    .values({
      id: UNIT_ID,
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: '2026-01-04',
    })
    .run();
}

function seedShiftType(id = 'st-d12'): string {
  handle.db
    .insert(s.shiftType)
    .values({
      id,
      unitId: UNIT_ID,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    })
    .run();
  return id;
}

function seedNurse(id = 'nurse-1', employeeId = 'E0001'): string {
  handle.db
    .insert(s.nurse)
    .values({
      id,
      unitId: UNIT_ID,
      employeeId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: '2019-03-01',
      isChargeEligible: true,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    })
    .run();
  return id;
}

describe('migrations', () => {
  it('creates every expected table', () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);

    for (const expected of [
      'unit',
      'shift_type',
      'nurse',
      'credential',
      'nurse_credential',
      'preference',
      'time_off_request',
      'acuity_tier',
      'ratio_rule',
      'census_forecast',
      'coverage_requirement',
      'schedule_period',
      'assignment',
      'call_off',
      'call_attempt',
      'pay_rate',
      'fairness_ledger',
      'audit_log',
      'rule_set',
      'rule_config',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('enables foreign key enforcement', () => {
    const [row] = handle.sqlite.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(row?.foreign_keys).toBe(1);
  });

  it('rejects a row referencing a missing parent', () => {
    // Without `PRAGMA foreign_keys = ON` this would silently succeed and orphan the row.
    expect(() =>
      handle.db
        .insert(s.nurse)
        .values({
          id: 'orphan',
          unitId: 'no-such-unit',
          employeeId: 'E9999',
          firstName: 'Orphan',
          lastName: 'Row',
          role: 'RN',
          employmentType: 'full_time',
          fte: 1,
          contractedHoursPerPeriod: 72,
          seniorityDate: '2020-01-01',
        })
        .run(),
    ).toThrow();
  });

  it('cascades a delete from unit to nurse', () => {
    seedUnit();
    seedNurse();
    handle.db.delete(s.unit).where(eq(s.unit.id, UNIT_ID)).run();
    expect(handle.db.select().from(s.nurse).all()).toHaveLength(0);
  });
});

describe('round-tripping domain entities', () => {
  it('preserves a nurse through insert and mapping', () => {
    seedUnit();
    seedNurse();
    const row = handle.db.select().from(s.nurse).get();
    expect(row).toBeDefined();
    const nurse = toNurse(row!);
    expect(nurse).toMatchObject({
      employeeId: 'E0001',
      role: 'RN',
      fte: 1,
      contractedHoursPerPeriod: 72,
      isChargeEligible: true,
    });
  });

  it('maps absent optional columns to undefined, never null', () => {
    seedUnit();
    seedNurse();
    const nurse = toNurse(handle.db.select().from(s.nurse).get()!);
    // The domain uses optional properties; a leaked null would force every rule in
    // packages/core to test for both.
    expect(nurse.phone).toBeUndefined();
    expect(nurse.notes).toBeUndefined();
    expect(Object.values(nurse)).not.toContain(null);
  });

  it('enforces unique employee ids within a unit', () => {
    seedUnit();
    seedNurse('nurse-1', 'E0001');
    expect(() => seedNurse('nurse-2', 'E0001')).toThrow();
  });
});

describe('preference union', () => {
  beforeEach(() => {
    seedUnit();
    seedShiftType();
    seedNurse();
  });

  it('round-trips a shift-type preference', () => {
    const original = {
      id: ids.preference(),
      nurseId: 'nurse-1',
      kind: 'prefer_shift_type' as const,
      shiftTypeId: 'st-d12',
      weight: 3,
    };
    handle.db.insert(s.preference).values(fromPreference(original)).run();
    const back = toPreference(handle.db.select().from(s.preference).get()!);
    expect(back).toEqual(original);
  });

  it('round-trips a weekend-appetite preference', () => {
    const original = {
      id: ids.preference(),
      nurseId: 'nurse-1',
      kind: 'weekend_appetite' as const,
      level: -1,
      weight: 5,
    };
    handle.db.insert(s.preference).values(fromPreference(original)).run();
    expect(toPreference(handle.db.select().from(s.preference).get()!)).toEqual(original);
  });

  it('round-trips a block-length preference', () => {
    const original = {
      id: ids.preference(),
      nurseId: 'nurse-1',
      kind: 'preferred_block_length' as const,
      shifts: 3,
      weight: 2,
    };
    handle.db.insert(s.preference).values(fromPreference(original)).run();
    expect(toPreference(handle.db.select().from(s.preference).get()!)).toEqual(original);
  });

  it('throws loudly on a corrupt row rather than dropping the preference', () => {
    // A silently dropped preference means a nurse's stated wishes quietly stop counting.
    handle.db
      .insert(s.preference)
      .values({
        id: 'pref-corrupt',
        nurseId: 'nurse-1',
        kind: 'prefer_shift_type',
        weight: 1,
        shiftTypeId: null,
      })
      .run();
    expect(() => toPreference(handle.db.select().from(s.preference).get()!)).toThrow(/corrupt/i);
  });
});

describe('time off', () => {
  beforeEach(() => {
    seedUnit();
    seedNurse();
  });

  it("defaults enteredBy to 'manager', the v1 self-service seam", () => {
    handle.db
      .insert(s.timeOffRequest)
      .values({
        id: ids.timeOff(),
        nurseId: 'nurse-1',
        startDate: '2026-02-01',
        endDate: '2026-02-05',
        type: 'pto',
        status: 'pending',
        submittedAt: Date.now(),
      })
      .run();
    const request = toTimeOffRequest(handle.db.select().from(s.timeOffRequest).get()!);
    expect(request.enteredBy).toBe('manager');
    expect(request.decidedAt).toBeUndefined();
  });

  it('sorts date ranges correctly as text', () => {
    // IsoDate is stored as text precisely because YYYY-MM-DD sorts chronologically.
    for (const [id, start] of [
      ['a', '2026-02-10'],
      ['b', '2026-01-05'],
      ['c', '2026-11-01'],
    ] as const) {
      handle.db
        .insert(s.timeOffRequest)
        .values({
          id,
          nurseId: 'nurse-1',
          startDate: start,
          endDate: start,
          type: 'pto',
          status: 'pending',
          submittedAt: Date.now(),
        })
        .run();
    }
    const ordered = handle.db
      .select()
      .from(s.timeOffRequest)
      .orderBy(s.timeOffRequest.startDate)
      .all()
      .map((r) => r.id);
    expect(ordered).toEqual(['b', 'a', 'c']);
  });
});

describe('audit log', () => {
  beforeEach(() => {
    seedUnit();
    seedNurse();
  });

  it('records a change with before and after state', () => {
    recordAudit(handle.db, {
      entityType: 'nurse',
      entityId: 'nurse-1',
      action: 'update',
      actor: 'manager',
      before: { fte: 1 },
      after: { fte: 0.8 },
      reason: 'Moved to part time at her request',
    });
    const history = auditHistoryFor(handle.db, 'nurse', 'nurse-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'update',
      actor: 'manager',
      before: { fte: 1 },
      after: { fte: 0.8 },
    });
  });

  it('refuses a denial with no reason', () => {
    // The denial text is what gets quoted if the decision is challenged.
    expect(() =>
      recordAuditStrict(handle.db, {
        entityType: 'time_off_request',
        entityId: 'to-1',
        action: 'deny',
        actor: 'manager',
      }),
    ).toThrow(/requires a reason/i);
  });

  it('refuses a denial whose reason is only whitespace', () => {
    expect(() =>
      recordAuditStrict(handle.db, {
        entityType: 'time_off_request',
        entityId: 'to-1',
        action: 'deny',
        actor: 'manager',
        reason: '   ',
      }),
    ).toThrow(/requires a reason/i);
  });

  it('allows a denial that states a reason', () => {
    expect(() =>
      recordAuditStrict(handle.db, {
        entityType: 'time_off_request',
        entityId: 'to-1',
        action: 'deny',
        actor: 'manager',
        reason: 'Would leave the unit below minimum staffing on 2026-02-14',
      }),
    ).not.toThrow();
  });

  it('returns history newest first', () => {
    recordAudit(handle.db, {
      entityType: 'nurse',
      entityId: 'nurse-1',
      action: 'create',
      actor: 'manager',
      at: 1000,
    });
    recordAudit(handle.db, {
      entityType: 'nurse',
      entityId: 'nurse-1',
      action: 'update',
      actor: 'manager',
      at: 2000,
    });
    const history = auditHistoryFor(handle.db, 'nurse', 'nurse-1');
    expect(history.map((h) => h.action)).toEqual(['update', 'create']);
  });
});

describe('transactions', () => {
  it('rolls back every write when the work throws', () => {
    seedUnit();
    expect(() =>
      transact(handle.db, (tx) => {
        tx.insert(s.nurse)
          .values({
            id: 'nurse-tx',
            unitId: UNIT_ID,
            employeeId: 'E1234',
            firstName: 'Rolled',
            lastName: 'Back',
            role: 'RN',
            employmentType: 'full_time',
            fte: 1,
            contractedHoursPerPeriod: 72,
            seniorityDate: '2020-01-01',
          })
          .run();
        // A partial publish is worse than a failed one.
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(handle.db.select().from(s.nurse).all()).toHaveLength(0);
  });

  it('commits when the work succeeds', () => {
    seedUnit();
    transact(handle.db, (tx) => {
      tx.insert(s.nurse)
        .values({
          id: 'nurse-tx',
          unitId: UNIT_ID,
          employeeId: 'E1234',
          firstName: 'Committed',
          lastName: 'Row',
          role: 'RN',
          employmentType: 'full_time',
          fte: 1,
          contractedHoursPerPeriod: 72,
          seniorityDate: '2020-01-01',
        })
        .run();
    });
    expect(handle.db.select().from(s.nurse).all()).toHaveLength(1);
  });
});

describe('assignment integrity', () => {
  it('rejects the same nurse holding the same shift twice on one day', () => {
    seedUnit();
    const shiftTypeId = seedShiftType();
    seedNurse();
    handle.db
      .insert(s.ruleSet)
      .values({
        id: 'rs-1',
        unitId: UNIT_ID,
        name: 'Default',
        version: 1,
        weekendDefinition: {
          startWeekday: 6,
          startMinute: 0,
          durationMinutes: 2880,
          mode: 'starts_within',
        },
        createdAt: Date.now(),
      })
      .run();
    handle.db
      .insert(s.schedulePeriod)
      .values({
        id: 'per-1',
        unitId: UNIT_ID,
        name: 'Test',
        startDate: '2026-01-04',
        endDate: '2026-01-17',
        status: 'draft',
        ruleSetId: 'rs-1',
        ruleSetVersion: 1,
      })
      .run();

    const values = {
      periodId: 'per-1',
      nurseId: 'nurse-1',
      shiftTypeId,
      date: isoDate('2026-01-05'),
      source: 'manual' as const,
    };
    handle.db
      .insert(s.assignment)
      .values({ id: 'a1', ...values })
      .run();
    expect(() =>
      handle.db
        .insert(s.assignment)
        .values({ id: 'a2', ...values })
        .run(),
    ).toThrow();
  });
});
