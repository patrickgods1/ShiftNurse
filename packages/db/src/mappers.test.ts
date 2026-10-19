import { DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from './audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from './client.js';
import { toNurse, toScheduleChange, toScheduleVersion } from './mappers.js';
import { getCallOff, reportCallOff } from './repositories/calloffs.js';
import { createShiftType, createUnit } from './repositories/config.js';
import { latestVersion, publishSchedule } from './repositories/publish.js';
import { createNurse, getNurse } from './repositories/roster.js';
import { saveRuleSet } from './repositories/rulesets.js';
import { createAssignment, createPeriod } from './repositories/schedule.js';
import { createTimeOffRequest, getTimeOffRequest } from './repositories/timeoff.js';
import type * as s from './schema.js';

let handle: OpenedDatabase;
let unitId: string;

beforeEach(() => {
  handle = openTestDatabase();
});
afterEach(() => handle.close());

function makeNurse() {
  const unit = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    'manager',
  );
  unitId = unit.id;
  return createNurse(
    handle.db,
    {
      unitId: unit.id,
      employeeId: 'E-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
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
    'manager',
  );
}

const shift = {
  id: 'a1',
  periodId: 'p1',
  nurseId: 'n1',
  shiftTypeId: 'st1',
  date: '2026-01-05',
};

function versionRow(assignments: unknown): typeof s.scheduleVersion.$inferSelect {
  return {
    id: 'v1',
    periodId: 'p1',
    version: 2,
    publishedAt: 1,
    publishedBy: 'manager',
    reason: null,
    assignments,
    added: 0,
    removed: 0,
    changed: 0,
  } as typeof s.scheduleVersion.$inferSelect;
}

function makePeriod() {
  const shiftTypeId = createShiftType(
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
    'manager',
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
      'manager',
    ),
  );
  const periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Test Period',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    'manager',
  ).id;
  return { periodId, shiftTypeId };
}

describe('mapping absent columns', () => {
  it('maps a nurse with no phone to an entity with no phone key at all', () => {
    const nurse = makeNurse();
    const row = { ...nurse, phone: null } as unknown as Parameters<typeof toNurse>[0];
    expect(Object.hasOwn(toNurse(row), 'phone')).toBe(false);
  });

  it('reads a nurse back exactly as her audit entry recorded her', () => {
    const nurse = makeNurse();
    expect(getNurse(handle.db, nurse.id)).toStrictEqual(
      auditHistoryFor(handle.db, 'nurse', nurse.id)[0]!.after,
    );
  });
});

describe('damaged published versions', () => {
  it('refuses to read a published version whose saved shifts are not a list', () => {
    expect(() => toScheduleVersion(versionRow({ not: 'an array' }))).toThrow(/damaged/);
  });

  it('refuses a published version with a shift that has no nurse', () => {
    const { nurseId: _n, ...noNurse } = shift;
    expect(() => toScheduleVersion(versionRow([noNurse]))).toThrow(/damaged/);
  });

  it('reads an intact published version unchanged', () => {
    expect(toScheduleVersion(versionRow([shift])).assignments).toStrictEqual([shift]);
  });

  it('refuses a change-log entry whose before is not a shift', () => {
    const row = {
      id: 'c1',
      periodId: 'p1',
      version: 1,
      kind: 'remove',
      source: 'manual',
      nurseId: 'n1',
      date: '2026-01-05',
      shiftTypeId: 'st1',
      assignmentId: 'a1',
      before: { not: 'a shift' },
      after: null,
      reason: null,
      consent: null,
      actor: 'manager',
      at: 1,
    } as unknown as typeof s.scheduleChange.$inferSelect;
    expect(() => toScheduleChange(row)).toThrow(/damaged/);
  });
});

describe('reading records back as their audit entries recorded them', () => {
  it('reads a leave request with no reason back exactly as its audit entry recorded it', () => {
    const nurse = makeNurse();
    const request = createTimeOffRequest(
      handle.db,
      {
        nurseId: nurse.id,
        startDate: isoDate('2026-02-02'),
        endDate: isoDate('2026-02-03'),
        type: 'pto',
      },
      'manager',
    );
    expect(getTimeOffRequest(handle.db, request.id)).toStrictEqual(
      auditHistoryFor(handle.db, 'time_off_request', request.id)[0]!.after,
    );
  });

  it('reads a call-off with no reason back exactly as its audit entry recorded it', () => {
    const nurse = makeNurse();
    const { periodId, shiftTypeId } = makePeriod();
    const shift = createAssignment(
      handle.db,
      { periodId, nurseId: nurse.id, shiftTypeId, date: isoDate('2026-01-20') },
      'manager',
    );
    const callOff = reportCallOff(handle.db, shift.id, 'manager');
    expect(getCallOff(handle.db, callOff.id)).toStrictEqual(
      auditHistoryFor(handle.db, 'call_off', callOff.id)[0]!.after,
    );
  });
});

describe('published versions and change-log rows', () => {
  function publishedVersion() {
    const nurse = makeNurse();
    const { periodId, shiftTypeId } = makePeriod();
    createAssignment(
      handle.db,
      { periodId, nurseId: nurse.id, shiftTypeId, date: isoDate('2026-01-20') },
      'manager',
    );
    transact(handle.db, (tx) => publishSchedule(tx, { periodId }, 'manager'));
    return latestVersion(handle.db, periodId)!;
  }

  it('reads a version the manager really published back with its shift intact', () => {
    const version = publishedVersion();
    expect(version.assignments).toHaveLength(1);
    expect(version.assignments[0]).toMatchObject({ date: '2026-01-20' });
    expect(Object.hasOwn(version, 'reason')).toBe(false);
  });

  const changeRow = (over: Record<string, unknown>) =>
    ({
      id: 'c1',
      periodId: 'p1',
      version: 1,
      kind: 'remove',
      source: 'manual',
      nurseId: 'n1',
      date: '2026-01-05',
      shiftTypeId: 'st1',
      assignmentId: 'a1',
      before: null,
      after: null,
      reason: 'Short staffed',
      consent: null,
      actor: 'manager',
      at: 1,
      ...over,
    }) as unknown as typeof s.scheduleChange.$inferSelect;

  it('refuses a change-log entry whose after is not a shift', () => {
    expect(() => toScheduleChange(changeRow({ after: 'gone' }))).toThrow(/damaged/);
  });

  it('reads a change-log entry whose shifts carry notes, a float and a holdover', () => {
    const detailed = { ...shift, notes: 'Covers 4 West', floatedTo: 'u2', holdoverMinutes: 30 };
    const change = toScheduleChange(changeRow({ before: detailed, after: shift }));
    expect(change.before).toStrictEqual(detailed);
    expect(change.after).toStrictEqual(shift);
  });

  it('gives a change-log entry with no consent no consent key and no empty sides', () => {
    const change = toScheduleChange(changeRow({}));
    expect(Object.hasOwn(change, 'consent')).toBe(false);
    expect(Object.hasOwn(change, 'before')).toBe(false);
    expect(Object.hasOwn(change, 'after')).toBe(false);
  });
});
