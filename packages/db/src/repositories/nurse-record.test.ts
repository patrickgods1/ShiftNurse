/**
 * A nurse's record for a grievance. It must hold every entry about the nurse in the range — their
 * own row, and the shifts, leave, exchanges and call-offs whose snapshots name them — and nothing
 * about anyone else, nothing outside the dates, and never the kept-apart entries, whose reason is
 * HR-sensitive and must not reach output that can be grieved.
 */

import { defaultRuleSet, isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { createIncompatibilityGroup } from './incompatibility.js';
import { nurseRecord } from './nurse-record.js';
import { publishSchedule, recordScheduleChange } from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let ana: Nurse;
let bea: Nurse;

const mkNurse = (firstName: string): Nurse =>
  createNurse(
    handle.db,
    {
      unitId,
      employeeId: nextEmployeeId(),
      firstName,
      lastName: 'Test',
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
  );

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  ana = mkNurse('Ana');
  bea = mkNurse('Bea');
});
afterEach(() => handle.close());

/** Local noon on a day of October 2020, long before the clock the test runs on, so the nurses created in setup (audited now) fall outside: the entry belongs to that day in any timezone. */
const noon = (day: number, hour = 12, month = 9) => new Date(2020, month, day, hour).getTime();

const log = (
  at: number,
  entityType: string,
  entityId: string,
  after: unknown,
  extra: { reason?: string; action?: 'create' | 'update' | 'delete' | 'deny' } = {},
) =>
  recordAudit(handle.db, {
    entityType,
    entityId,
    action: extra.action ?? 'update',
    actor: ACTOR,
    after,
    ...(extra.reason ? { reason: extra.reason } : {}),
    at,
  });

const record = (start = '2020-10-01', end = '2020-10-31') =>
  nurseRecord(handle.db, ana.id, isoDate(start), isoDate(end));

describe('what a nurse’s record holds', () => {
  it('has their own row and the shifts, leave and exchanges that name them, oldest first', () => {
    log(
      noon(9),
      'time_off_request',
      'to-1',
      { nurseId: ana.id, startDate: '2020-10-20', endDate: '2020-10-22' },
      {
        action: 'deny',
        reason: 'Short staffed that week',
      },
    );
    log(
      noon(6),
      'assignment',
      'a-1',
      { nurseId: ana.id, date: '2020-10-12' },
      { action: 'create' },
    );
    log(noon(7), 'nurse', ana.id, { firstName: 'Ana' });
    log(noon(8), 'shift_swap', 'sw-1', { requestingNurseId: bea.id, counterpartyNurseId: ana.id });
    const rows = record().audit;
    expect(rows.map((r) => [r.entityType, r.action])).toEqual([
      ['assignment', 'create'],
      ['nurse', 'update'],
      ['shift_swap', 'update'],
      ['time_off_request', 'deny'],
    ]);
    expect(rows[3]).toMatchObject({
      actor: 'manager',
      reason: 'Short staffed that week',
      concerns: '2020-10-20 to 2020-10-22',
    });
    expect(rows[0]!.concerns).toBe('2020-10-12');
  });

  it('leaves out other nurses’ entries, including an id that merely starts like theirs', () => {
    log(noon(6), 'assignment', 'a-1', { nurseId: ana.id, date: '2020-10-12' });
    log(noon(6), 'assignment', 'a-2', { nurseId: bea.id, date: '2020-10-12' });
    log(noon(6), 'assignment', 'a-3', { nurseId: `${ana.id}x`, date: '2020-10-12' });
    expect(record().audit.map((r) => r.entityId)).toEqual(['a-1']);
  });

  it('keeps entries from the first and last days of the range and drops those a day outside', () => {
    log(new Date(2020, 8, 30, 23, 30).getTime(), 'assignment', 'before', { nurseId: ana.id });
    log(new Date(2020, 9, 1, 0, 30).getTime(), 'assignment', 'first', { nurseId: ana.id });
    log(new Date(2020, 9, 31, 23, 30).getTime(), 'assignment', 'last', { nurseId: ana.id });
    log(new Date(2020, 10, 1, 0, 30).getTime(), 'assignment', 'after', { nurseId: ana.id });
    expect(record().audit.map((r) => r.entityId)).toEqual(['first', 'last']);
  });

  it('never includes the kept-apart entries or their reason', () => {
    const group = transact(handle.db, (tx) =>
      createIncompatibilityGroup(
        tx,
        { unitId, name: 'Day pair', nurseIds: [ana.id, bea.id], maxTogether: 1 },
        'Personal conflict, HR case 41',
        ACTOR,
      ),
    );
    // A snapshot that does name the nurse by `nurseId` is still kept out by its entity type.
    log(
      Date.now(),
      'incompatibility_group',
      group.id,
      { nurseId: ana.id },
      { reason: 'HR case 41' },
    );
    const now = new Date();
    const day = isoDate(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    );
    const rows = nurseRecord(handle.db, ana.id, day, day).audit;
    expect(rows.some((r) => r.entityType === 'incompatibility_group')).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('HR case 41');
  });
});

describe('medical leave in a nurse’s record', () => {
  it('leaves out FMLA certifications, which concern a medical condition', () => {
    log(
      Date.now(),
      'fmla_certification',
      'cert-1',
      { nurseId: ana.id, note: 'Intermittent: cardiology follow-up' },
      { reason: 'Certified by Dr Lee' },
    );
    const now = new Date();
    const day = isoDate(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    );
    const rows = nurseRecord(handle.db, ana.id, day, day).audit;
    expect(rows.some((r) => r.entityType === 'fmla_certification')).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('cardiology');
  });
});

describe('a nurse’s changes to published shifts', () => {
  it('lists theirs, with the period and the stated reason, and not another nurse’s', () => {
    const shift = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Day 12',
        abbreviation: 'D12',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#000',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    );
    const rules = transact(handle.db, (tx) => saveRuleSet(tx, defaultRuleSet(unitId), ACTOR));
    const period = createPeriod(
      handle.db,
      {
        unitId,
        name: 'Fall',
        startDate: isoDate('2026-10-04'),
        endDate: isoDate('2026-11-14'),
        ruleSetId: rules.id,
        ruleSetVersion: rules.version,
      },
      ACTOR,
    );
    publishSchedule(handle.db, { periodId: period.id, ledger: [] }, ACTOR);
    const place = (nurse: Nurse) =>
      createAssignment(
        handle.db,
        {
          periodId: period.id,
          nurseId: nurse.id,
          shiftTypeId: shift.id,
          date: isoDate('2026-10-10'),
        },
        ACTOR,
      );
    for (const nurse of [ana, bea]) {
      const a = place(nurse);
      recordScheduleChange(
        handle.db,
        {
          periodId: period.id,
          kind: 'added',
          assignmentId: a.id,
          nurseId: nurse.id,
          date: a.date,
          shiftTypeId: shift.id,
          after: a,
          reason: `Cover for ${nurse.firstName}`,
        },
        ACTOR,
      );
    }
    const now = new Date();
    const day = isoDate(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    );
    const changes = nurseRecord(handle.db, ana.id, day, day).scheduleChanges;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      periodName: 'Fall',
      kind: 'added',
      date: '2026-10-10',
      reason: 'Cover for Ana',
      actor: 'manager',
    });
  });
});

describe('asking for a record', () => {
  it('refuses a range that ends before it starts, and a nurse who is not on the roster', () => {
    expect(() => record('2020-10-31', '2020-10-01')).toThrow('The record ends before it starts');
    expect(() =>
      nurseRecord(handle.db, 'nobody', isoDate('2020-10-01'), isoDate('2020-10-31')),
    ).toThrow('That nurse is not on the roster');
  });
});
