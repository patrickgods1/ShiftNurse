/**
 * Float records: the history the rotation reads and the objection a floated nurse can have put
 * on record. Each write leaves an audit row; an objection never changes who was floated.
 */

import { isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { createFloatRecord, listFloatRecords, recordFloatObjection } from './float-records.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let nurseId: string;
let shiftTypeId: string;

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
  nurseId = createNurse(
    handle.db,
    {
      unitId,
      employeeId: nextEmployeeId(),
      firstName: 'Vera',
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
  ).id;
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
});
afterEach(() => handle.close());

function float(date: string, volunteered = false) {
  return createFloatRecord(
    handle.db,
    { unitId, nurseId, date: isoDate(date), shiftTypeId, toUnit: '4B Telemetry', volunteered },
    ACTOR,
  );
}

describe('float records', () => {
  it('records a float with an audit row and lists it', () => {
    const record = float('2026-10-06');
    expect(record).toMatchObject({ toUnit: '4B Telemetry', volunteered: false, actor: ACTOR });
    expect(listFloatRecords(handle.db, unitId, isoDate('2026-01-01'))).toEqual([record]);
    expect(auditHistoryFor(handle.db, 'float_record', record.id)[0]).toMatchObject({
      action: 'create',
      actor: ACTOR,
    });
  });

  it('lists only the floats since the date asked for, oldest first', () => {
    const late = float('2026-09-01');
    const early = float('2025-06-01');
    const mid = float('2026-02-01', true);
    expect(listFloatRecords(handle.db, unitId, isoDate('2025-12-01'))).toEqual([mid, late]);
    expect(listFloatRecords(handle.db, unitId, isoDate('2025-01-01'))).toEqual([early, mid, late]);
  });

  it('records the nurse’s objection and audits it with the record as it stood', () => {
    const record = float('2026-10-06');
    const updated = recordFloatObjection(
      handle.db,
      record.id,
      ' Not competent on telemetry ',
      ACTOR,
    );
    expect(updated.objection).toBe('Not competent on telemetry');
    expect(listFloatRecords(handle.db, unitId, isoDate('2026-01-01'))[0]!.objection).toBe(
      'Not competent on telemetry',
    );
    const entry = auditHistoryFor(handle.db, 'float_record', record.id)[0]!;
    expect(entry.action).toBe('update');
    expect(entry.before).toEqual(record);
    expect(entry.after).toEqual(updated);
  });

  it('refuses a blank objection and leaves the record alone', () => {
    const record = float('2026-10-06');
    expect(() => recordFloatObjection(handle.db, record.id, '  ', ACTOR)).toThrow(/objection/);
    expect(auditHistoryFor(handle.db, 'float_record', record.id)).toHaveLength(1);
  });

  it('refuses an objection on a float that does not exist', () => {
    expect(() => recordFloatObjection(handle.db, 'nope', 'x', ACTOR)).toThrow(/not found/);
  });
});
