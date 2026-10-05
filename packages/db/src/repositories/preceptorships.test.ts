/**
 * Preceptorships: the record that keeps an orientee on shifts their preceptor works. A pairing a
 * nurse with themselves, a nurse from another unit or a range running backwards would look like
 * orientation and constrain nothing, so each is refused in words; every change is audited.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import {
  createPreceptorship,
  deletePreceptorship,
  listPreceptorships,
  listPreceptorshipsOverlapping,
  updatePreceptorship,
} from './preceptorships.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let newHire: Nurse;
let veteran: Nurse;
let stranger: Nurse;

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

function mkNurse(forUnit: string, firstName: string): Nurse {
  return createNurse(
    handle.db,
    {
      unitId: forUnit,
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
}

beforeEach(() => {
  handle = openTestDatabase();
  unitId = mkUnit('4 West').id;
  newHire = mkNurse(unitId, 'Nina');
  veteran = mkNurse(unitId, 'Vera');
  stranger = mkNurse(mkUnit('Other').id, 'Zed');
});
afterEach(() => handle.close());

function pair(start: string, end: string, preceptor = veteran) {
  return createPreceptorship(
    handle.db,
    {
      unitId,
      orienteeId: newHire.id,
      preceptorId: preceptor.id,
      startDate: isoDate(start),
      endDate: isoDate(end),
    },
    ACTOR,
  );
}

describe('recording an orientation', () => {
  it('stores the pair and its dates and audits the creation', () => {
    const record = pair('2026-10-05', '2026-11-15');
    expect(listPreceptorships(handle.db, unitId)).toEqual([record]);
    expect(auditHistoryFor(handle.db, 'preceptorship', record.id)[0]).toMatchObject({
      action: 'create',
      after: { orienteeId: newHire.id, preceptorId: veteran.id },
    });
  });

  it('refuses a nurse as their own preceptor, a backwards range, and a nurse from another unit', () => {
    expect(() => pair('2026-10-05', '2026-10-06', newHire)).toThrow(
      'A nurse cannot be their own preceptor',
    );
    expect(() => pair('2026-10-06', '2026-10-05')).toThrow('The orientation ends before it starts');
    expect(() => pair('2026-10-05', '2026-10-06', stranger)).toThrow(
      'That nurse is not on this unit',
    );
    expect(listPreceptorships(handle.db, unitId)).toEqual([]);
  });

  it('lists only the records that touch the window, whole', () => {
    const before = pair('2026-08-01', '2026-08-31');
    const straddling = pair('2026-09-25', '2026-10-06');
    const after = pair('2026-12-01', '2026-12-31');
    const ids = listPreceptorshipsOverlapping(
      handle.db,
      unitId,
      isoDate('2026-10-01'),
      isoDate('2026-10-31'),
    ).map((p) => p.id);
    expect(ids).toEqual([straddling.id]);
    expect(ids).not.toContain(before.id);
    expect(ids).not.toContain(after.id);
  });
});

describe('changing an orientation', () => {
  it('extends the end date and audits what it was before', () => {
    const record = pair('2026-10-05', '2026-11-15');
    const updated = updatePreceptorship(
      handle.db,
      record.id,
      { endDate: isoDate('2026-12-01') },
      ACTOR,
    );
    expect(updated.endDate).toBe('2026-12-01');
    expect(auditHistoryFor(handle.db, 'preceptorship', record.id)[0]).toMatchObject({
      action: 'update',
      before: { endDate: '2026-11-15' },
      after: { endDate: '2026-12-01' },
    });
  });

  it('refuses to move the record to another nurse', () => {
    const record = pair('2026-10-05', '2026-11-15');
    expect(() =>
      updatePreceptorship(handle.db, record.id, { preceptorId: stranger.id } as never, ACTOR),
    ).toThrow(/preceptorship/);
  });

  it('removes a record and audits it with what it was', () => {
    const record = pair('2026-10-05', '2026-11-15');
    deletePreceptorship(handle.db, record.id, ACTOR);
    expect(listPreceptorships(handle.db, unitId)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'preceptorship', record.id)[0]).toMatchObject({
      action: 'delete',
      before: { id: record.id },
    });
  });
});
