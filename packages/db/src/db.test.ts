/**
 * Integration tests for the persistence layer.
 *
 * These run against a real in-memory SQLite database with the real generated migrations —
 * not a mock and not a hand-built schema. That is deliberate: a test that builds its own
 * tables can pass while the migrations are broken, which is the one failure mode that would
 * reach a user as "the app won't start".
 */

import { DEFAULT_FAIRNESS_WEIGHTS, type Id, isoDate } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recordAudit, recordAuditStrict } from './audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from './client.js';
import { ids } from './ids.js';
import { fromPreference, toNurse, toPreference, toTimeOffRequest } from './mappers.js';
import { createShiftType, createUnit } from './repositories/config.js';
import { repricePeriod } from './repositories/pay-snapshot.js';
import { publishSchedule, recordScheduleChange } from './repositories/publish.js';
import { createNurse } from './repositories/roster.js';
import { saveRuleSet } from './repositories/rulesets.js';
import { createAssignment, createPeriod, deleteDraftPeriod } from './repositories/schedule.js';
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
    expect(row).toMatchObject({ employeeId: 'E0001' });
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

  it('cannot be rewritten or deleted after the fact, even with raw SQL', () => {
    recordAudit(handle.db, {
      entityType: 'time_off_request',
      entityId: 'req-1',
      action: 'deny',
      actor: 'manager',
      reason: 'Three nurses already off that weekend',
    });
    expect(() => handle.sqlite.prepare("UPDATE audit_log SET reason = 'Approved'").run()).toThrow(
      /append-only/,
    );
    expect(() => handle.sqlite.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(auditHistoryFor(handle.db, 'time_off_request', 'req-1')[0]?.reason).toBe(
      'Three nurses already off that weekend',
    );
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

/**
 * The validation triggers (migration 0043). IPC and the CSV importer refuse these values first;
 * these tests write past them, as a seed or preset could, to show the file itself refuses.
 */
describe('the file refuses data the app would misread', () => {
  const nurseRow = (overrides: Partial<typeof s.nurse.$inferInsert>) => ({
    id: 'nurse-bad',
    unitId: UNIT_ID,
    employeeId: 'E0099',
    firstName: 'Bad',
    lastName: 'Row',
    role: 'RN' as const,
    employmentType: 'full_time' as const,
    fte: 1,
    contractedHoursPerPeriod: 72,
    seniorityDate: '2019-03-01',
    ...overrides,
  });
  const insertNurse = (overrides: Partial<typeof s.nurse.$inferInsert>) => () =>
    handle.db.insert(s.nurse).values(nurseRow(overrides)).run();

  function seedRuleSet(): void {
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
  }
  const periodRow = (overrides: Partial<typeof s.schedulePeriod.$inferInsert>) => ({
    id: 'per-1',
    unitId: UNIT_ID,
    name: 'Test',
    startDate: '2026-01-04',
    endDate: '2026-01-17',
    status: 'draft' as const,
    ruleSetId: 'rs-1',
    ruleSetVersion: 1,
    ...overrides,
  });

  beforeEach(() => {
    seedUnit();
  });

  it('refuses a nurse whose role is not RN, LPN or CNA', () => {
    expect(insertNurse({ role: 'SURGEON' as 'RN' })).toThrow(
      "A nurse's role must be RN, LPN or CNA.",
    );
    seedNurse();
    expect(() =>
      handle.sqlite.prepare(`UPDATE nurse SET role = 'SURGEON' WHERE id = 'nurse-1'`).run(),
    ).toThrow("A nurse's role must be RN, LPN or CNA.");
  });

  it('refuses an employment type the contract rules do not know', () => {
    expect(insertNurse({ employmentType: 'casual' as 'full_time' })).toThrow(
      "A nurse's employment type must be full time, part time, per diem or agency.",
    );
  });

  it('refuses an FTE outside 0 to 1.5 and negative contracted hours', () => {
    expect(insertNurse({ fte: -3 })).toThrow("A nurse's FTE must be from 0 to 1.5.");
    expect(insertNurse({ fte: 1.6 })).toThrow("A nurse's FTE must be from 0 to 1.5.");
    expect(insertNurse({ contractedHoursPerPeriod: -72 })).toThrow(
      'Contracted hours cannot be negative.',
    );
    // The edges are real contracts: a zero-FTE per-diem and a 1.5 FTE double-time agreement.
    insertNurse({ id: 'n-zero', employeeId: 'E0100', fte: 0, contractedHoursPerPeriod: 0 })();
    insertNurse({ id: 'n-max', employeeId: 'E0101', fte: 1.5 })();
    expect(() =>
      handle.db.update(s.nurse).set({ fte: 2 }).where(eq(s.nurse.id, 'n-max')).run(),
    ).toThrow("A nurse's FTE must be from 0 to 1.5.");
  });

  it('refuses a seniority date that is not a real day', () => {
    expect(insertNurse({ seniorityDate: 'yesterday' })).toThrow(
      "A nurse's seniority date must be a date.",
    );
    // February 2026 has 28 days; SQLite's date() would quietly read this as March 2.
    expect(insertNurse({ seniorityDate: '2026-02-30' })).toThrow(
      "A nurse's seniority date must be a date.",
    );
    expect(insertNurse({ hireDate: '2026-13-01' })).toThrow("A nurse's hire date must be a date.");
    insertNurse({ hireDate: '2024-02-29' })();
  });

  it('refuses a pay period of zero days', () => {
    expect(() =>
      handle.db
        .insert(s.unit)
        .values({
          id: 'unit-zero',
          name: '5 East',
          unitType: 'ICU',
          payPeriodDays: 0,
          payPeriodAnchor: '2026-01-04',
        })
        .run(),
    ).toThrow('A pay period must be a whole number of days, at least one.');
    expect(() =>
      handle.db.update(s.unit).set({ payPeriodDays: 0 }).where(eq(s.unit.id, UNIT_ID)).run(),
    ).toThrow('A pay period must be a whole number of days, at least one.');
    expect(() =>
      handle.sqlite.prepare(`UPDATE unit SET pay_period_days = 13.5 WHERE id = ?`).run(UNIT_ID),
    ).toThrow('A pay period must be a whole number of days, at least one.');
    expect(() =>
      handle.db
        .update(s.unit)
        .set({ payPeriodAnchor: 'next Sunday' })
        .where(eq(s.unit.id, UNIT_ID))
        .run(),
    ).toThrow("The pay period's first day must be a date.");
    expect(handle.db.select().from(s.unit).get()).toMatchObject({
      payPeriodDays: 14,
      payPeriodAnchor: '2026-01-04',
    });
  });

  it('refuses a period status that does not exist, and a period that ends before it starts', () => {
    seedRuleSet();
    const insertPeriod = (overrides: Partial<typeof s.schedulePeriod.$inferInsert>) => () =>
      handle.db.insert(s.schedulePeriod).values(periodRow(overrides)).run();
    expect(insertPeriod({ status: 'bogus' as 'draft' })).toThrow(
      'A schedule period is draft, published or archived.',
    );
    expect(insertPeriod({ endDate: '2026-01-03' })).toThrow('The period ends before it starts.');
    expect(insertPeriod({ startDate: 'soon' })).toThrow(
      "A schedule period's start and end must be dates.",
    );
    // A one-day period is a real period.
    insertPeriod({ id: 'per-day', endDate: '2026-01-04' })();
    insertPeriod({})();
    expect(() =>
      handle.db
        .update(s.schedulePeriod)
        .set({ status: 'bogus' as 'draft' })
        .where(eq(s.schedulePeriod.id, 'per-1'))
        .run(),
    ).toThrow('A schedule period is draft, published or archived.');
    expect(() =>
      handle.db
        .update(s.schedulePeriod)
        .set({ endDate: '2026-01-01' })
        .where(eq(s.schedulePeriod.id, 'per-1'))
        .run(),
    ).toThrow('The period ends before it starts.');
  });

  it('still lets a nurse be deactivated when an unrelated column holds an old bad value', () => {
    // Only the guarded columns fire the update trigger, so a row an older release let through
    // can still be deactivated or renamed rather than becoming impossible to touch.
    const triggerSql = (name: string) =>
      (
        handle.sqlite.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as {
          sql: string;
        }
      ).sql;
    expect(triggerSql('nurse_valid_update')).toContain('UPDATE OF `role`');
    expect(triggerSql('unit_valid_update')).toContain('UPDATE OF `pay_period_days`');
    expect(triggerSql('schedule_period_valid_update')).toContain('UPDATE OF `status`');
    seedNurse();
    handle.db.update(s.nurse).set({ active: false }).where(eq(s.nurse.id, 'nurse-1')).run();
    expect(handle.db.select().from(s.nurse).get()?.active).toBe(false);
  });

  it('refuses to delete a nurse who has worked a shift, and keeps her shifts', () => {
    const shiftTypeId = seedShiftType();
    seedNurse();
    seedRuleSet();
    handle.db.insert(s.schedulePeriod).values(periodRow({})).run();
    handle.db
      .insert(s.assignment)
      .values({
        id: 'a1',
        periodId: 'per-1',
        nurseId: 'nurse-1',
        shiftTypeId,
        date: isoDate('2026-01-05'),
        source: 'manual',
      })
      .run();
    expect(() => handle.db.delete(s.nurse).where(eq(s.nurse.id, 'nurse-1')).run()).toThrow(
      'A nurse with schedule history cannot be deleted; deactivate them instead.',
    );
    expect(handle.db.select().from(s.nurse).all()).toHaveLength(1);
    expect(handle.db.select().from(s.assignment).all()).toHaveLength(1);
  });

  it('refuses to delete a nurse whose only history is her fairness ledger', () => {
    seedNurse();
    handle.db
      .insert(s.fairnessLedger)
      .values({
        id: 'l1',
        nurseId: 'nurse-1',
        periodId: 'import:2025-12-07',
        periodStart: '2025-12-07',
      })
      .run();
    expect(() => handle.db.delete(s.nurse).where(eq(s.nurse.id, 'nurse-1')).run()).toThrow(
      /deactivate them instead/,
    );
    expect(handle.db.select().from(s.fairnessLedger).all()).toHaveLength(1);
  });

  it('deletes a nurse who never worked a shift', () => {
    seedNurse();
    handle.db.delete(s.nurse).where(eq(s.nurse.id, 'nurse-1')).run();
    expect(handle.db.select().from(s.nurse).all()).toHaveLength(0);
  });
});

describe('history the app never rewrites', () => {
  const ACTOR = 'manager';
  const ruleDraft = (unitId: Id) => ({
    unitId,
    name: 'Default',
    weekendDefinition: {
      startWeekday: 6 as const,
      startMinute: 0,
      durationMinutes: 2880,
      mode: 'starts_within' as const,
    },
    fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
    configs: [{ ruleId: 'no-mandatory-overtime', enabled: false, params: {} }],
  });
  let unitId: Id;
  let periodId: Id;
  let nurseId: Id;
  let shiftTypeId: Id;
  let assignmentId: Id;

  beforeEach(() => {
    const db = handle.db;
    unitId = createUnit(
      db,
      {
        name: '4 West',
        unitType: 'Med-Surg',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    ).id;
    const ruleSet = transact(db, (tx) => saveRuleSet(tx, ruleDraft(unitId), ACTOR));
    shiftTypeId = createShiftType(
      db,
      {
        unitId,
        name: 'Day 12',
        abbreviation: 'D12',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#fff',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    ).id;
    nurseId = createNurse(
      db,
      {
        unitId,
        employeeId: 'E1',
        firstName: 'Ana',
        lastName: 'Reyes',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: true,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    ).id;
    periodId = createPeriod(
      db,
      {
        unitId,
        name: 'October 4–17',
        startDate: isoDate('2026-10-04'),
        endDate: isoDate('2026-10-17'),
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    ).id;
    assignmentId = createAssignment(
      db,
      { periodId, nurseId, shiftTypeId, date: isoDate('2026-10-05') },
      ACTOR,
    ).id;
    transact(db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    recordScheduleChange(
      db,
      {
        periodId,
        kind: 'added',
        assignmentId,
        nurseId,
        date: isoDate('2026-10-05'),
        shiftTypeId,
        reason: 'Covering a sick call',
      },
      ACTOR,
    );
  });

  const run = (sql: string) => handle.sqlite.prepare(sql).run();

  it('refuses to edit or delete a saved rule set version', () => {
    expect(() => run("UPDATE rule_set SET name = 'x'")).toThrow(/save a new version instead/);
    expect(() => run('DELETE FROM rule_set')).toThrow(/schedules were judged by it/);
    expect(() => run("UPDATE rule_config SET params = '{}'")).toThrow(/save a new version instead/);
    expect(() => run('DELETE FROM rule_config')).toThrow(/schedules were judged by it/);
  });

  it('refuses to edit or delete what went out to staff', () => {
    expect(() => run("UPDATE schedule_version SET reason = 'x'")).toThrow(/cannot be changed/);
    expect(() => run('DELETE FROM schedule_version')).toThrow(/cannot be deleted/);
  });

  it('refuses to edit or delete the change log', () => {
    expect(() => run("UPDATE schedule_change SET reason = 'x'")).toThrow(
      /change log of a published schedule cannot be changed/,
    );
    expect(() => run('DELETE FROM schedule_change')).toThrow(
      /change log of a published schedule cannot be deleted/,
    );
  });

  it('refuses to edit or delete a pay snapshot', () => {
    expect(() => run("UPDATE pay_config_snapshot SET reason = 'x'")).toThrow(/reprice it instead/);
    expect(() => run('DELETE FROM pay_config_snapshot')).toThrow(/cannot be deleted/);
  });

  it('refuses to edit or delete banked comp time, and one credit per nurse per period', () => {
    const credit = (id: string) =>
      handle.db
        .insert(s.compTimeCredit)
        .values({
          id,
          nurseId,
          periodId,
          overtimeHours: 4,
          creditedHours: 6,
          paidOvertimeHours: 0,
          createdAt: 1_000,
        })
        .run();
    credit('credit-1');
    expect(() => run("UPDATE comp_time_credit SET reason = 'x'")).toThrow(
      /correct the nurse's comp balance under Leave instead/,
    );
    expect(() => run('DELETE FROM comp_time_credit')).toThrow(/banked from a published schedule/);
    expect(() => credit('credit-2')).toThrow(/UNIQUE/);
  });

  it('still saves new rules, publishes, republishes and logs changes', () => {
    const v2 = transact(handle.db, (tx) => saveRuleSet(tx, ruleDraft(unitId), ACTOR));
    expect(v2.version).toBe(2);
    createAssignment(
      handle.db,
      { periodId, nurseId, shiftTypeId, date: isoDate('2026-10-07') },
      ACTOR,
      'Extra day',
    );
    const again = transact(handle.db, (tx) =>
      publishSchedule(tx, { periodId, reason: 'Extra day' }, ACTOR),
    );
    expect(again.version.version).toBe(2);
    const snap = transact(handle.db, (tx) => repricePeriod(tx, periodId, ACTOR, 'New contract'));
    expect(snap.seq).toBe(2);
  });

  it('still deletes a draft that was never published', () => {
    const draft = createPeriod(
      handle.db,
      {
        unitId,
        name: 'October 18–31',
        startDate: isoDate('2026-10-18'),
        endDate: isoDate('2026-10-31'),
        ruleSetId: handle.db.select().from(s.ruleSet).get()!.id,
        ruleSetVersion: 1,
      },
      ACTOR,
    );
    deleteDraftPeriod(handle.db, draft.id, ACTOR);
    expect(handle.db.select().from(s.schedulePeriod).all()).toHaveLength(1);
  });

  it('refuses to delete a unit that has saved rules', () => {
    // The cascade reaches rule sets, versions and the change log; whichever it meets first aborts.
    expect(() => run('DELETE FROM unit')).toThrow(/cannot be deleted/);
    expect(handle.db.select().from(s.unit).all()).toHaveLength(1);
  });
});
