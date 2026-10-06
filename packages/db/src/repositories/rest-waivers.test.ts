/**
 * Rest waivers: a nurse's written waiver of minimum rest before one shift. The reason is what is
 * read out if the turnaround is grieved, so a blank one is refused on both create and remove, and
 * every write is audited with it.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import {
  createRestWaiver,
  deleteRestWaiver,
  listRestWaivers,
  restWaiversForPeriod,
} from './rest-waivers.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let vera: Nurse;
let nina: Nurse;
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
  vera = mkNurse(unitId, 'Vera');
  nina = mkNurse(unitId, 'Nina');
  stranger = mkNurse(mkUnit('Other').id, 'Zed');
});
afterEach(() => handle.close());

function waive(nurse: Nurse, date: string, reason = 'Signed waiver, picked up the evening') {
  return createRestWaiver(
    handle.db,
    { unitId, nurseId: nurse.id, date: isoDate(date), reason },
    ACTOR,
  );
}

describe('recording a rest waiver', () => {
  it('stores it and audits the creation with the reason', () => {
    const record = waive(vera, '2026-10-06');
    expect(listRestWaivers(handle.db, unitId)).toEqual([record]);
    expect(auditHistoryFor(handle.db, 'rest_waiver', record.id)[0]).toMatchObject({
      action: 'create',
      reason: 'Signed waiver, picked up the evening',
      after: { nurseId: vera.id, date: '2026-10-06' },
    });
  });

  it('refuses a blank reason and writes nothing', () => {
    expect(() => waive(vera, '2026-10-06', '   ')).toThrow(/Give a reason/);
    expect(listRestWaivers(handle.db, unitId)).toEqual([]);
  });

  it('refuses a second waiver for the same nurse and date', () => {
    waive(vera, '2026-10-06');
    expect(() => waive(vera, '2026-10-06')).toThrow('already has a rest waiver on 2026-10-06');
    expect(() => waive(nina, '2026-10-06')).not.toThrow();
  });

  it('refuses a nurse from another unit', () => {
    expect(() => waive(stranger, '2026-10-06')).toThrow('That nurse is not on this unit');
  });

  it('lists by date, then nurse', () => {
    const later = waive(vera, '2026-10-09');
    const a = waive(vera, '2026-10-06');
    const b = waive(nina, '2026-10-06');
    const [first, second] = [a, b].sort((x, y) => x.nurseId.localeCompare(y.nurseId));
    expect(listRestWaivers(handle.db, unitId).map((w) => w.id)).toEqual([
      first!.id,
      second!.id,
      later.id,
    ]);
  });

  it('reads only the waivers dated within the period, inclusive', () => {
    waive(vera, '2026-10-03');
    const first = waive(vera, '2026-10-04');
    const last = waive(vera, '2026-10-17');
    waive(vera, '2026-10-18');
    expect(
      restWaiversForPeriod(handle.db, unitId, isoDate('2026-10-04'), isoDate('2026-10-17')).map(
        (w) => w.id,
      ),
    ).toEqual([first.id, last.id]);
  });
});

describe('removing a rest waiver', () => {
  it('removes it and audits it with what it was and why', () => {
    const record = waive(vera, '2026-10-06');
    deleteRestWaiver(handle.db, record.id, 'Nurse withdrew the waiver', ACTOR);
    expect(listRestWaivers(handle.db, unitId)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'rest_waiver', record.id)[0]).toMatchObject({
      action: 'delete',
      reason: 'Nurse withdrew the waiver',
      before: { id: record.id, date: '2026-10-06' },
    });
  });

  it('refuses a blank reason and keeps the waiver', () => {
    const record = waive(vera, '2026-10-06');
    expect(() => deleteRestWaiver(handle.db, record.id, '', ACTOR)).toThrow(/Give a reason/);
    expect(listRestWaivers(handle.db, unitId)).toEqual([record]);
  });
});
