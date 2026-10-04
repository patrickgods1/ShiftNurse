/**
 * Overtime volunteers: the record that makes an overtime shift voluntary where the law bans
 * mandatory overtime. A range that runs backwards, or a nurse from another unit, would look like
 * an offer and cover nothing, so both are refused; every change is audited with its `before`.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createUnit } from './config.js';
import {
  createOvertimeVolunteer,
  deleteOvertimeVolunteer,
  listOvertimeVolunteers,
  listOvertimeVolunteersOverlapping,
  updateOvertimeVolunteer,
} from './overtime-volunteers.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let ana: Nurse;
let stranger: Nurse;

function unit(name: string) {
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

function nurse(forUnit: string, n: number): Nurse {
  return createNurse(
    handle.db,
    {
      unitId: forUnit,
      employeeId: `E${forUnit}-${n}`,
      firstName: `Nurse${n}`,
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

const offer = (start: string, end: string, note?: string) =>
  createOvertimeVolunteer(
    handle.db,
    {
      unitId,
      nurseId: ana.id,
      startDate: isoDate(start),
      endDate: isoDate(end),
      ...(note ? { note } : {}),
    },
    ACTOR,
  );

beforeEach(() => {
  handle = openTestDatabase();
  unitId = unit('4 West').id;
  ana = nurse(unitId, 1);
  stranger = nurse(unit('5 East').id, 2);
});

afterEach(() => handle.close());

describe('overtime volunteers', () => {
  it('records an offer with the note on how it was made, and audits it', () => {
    const v = offer('2026-10-05', '2026-10-11', '  texted Oct 3: any nights that week ');
    expect(v.note).toBe('texted Oct 3: any nights that week');
    expect(listOvertimeVolunteers(handle.db, unitId)).toEqual([v]);
    const [entry] = auditHistoryFor(handle.db, 'overtime_volunteer', v.id);
    expect(entry).toMatchObject({ action: 'create', actor: ACTOR, after: v });
  });

  it('refuses an offer that ends before it starts', () => {
    expect(() => offer('2026-10-11', '2026-10-05')).toThrow('The offer ends before it starts');
    expect(listOvertimeVolunteers(handle.db, unitId)).toEqual([]);
  });

  it('refuses an offer from a nurse on another unit', () => {
    expect(() =>
      createOvertimeVolunteer(
        handle.db,
        {
          unitId,
          nurseId: stranger.id,
          startDate: isoDate('2026-10-05'),
          endDate: isoDate('2026-10-06'),
        },
        ACTOR,
      ),
    ).toThrow('That nurse is not on this unit');
  });

  it('lists only the offers that touch the window, whole', () => {
    const before = offer('2026-09-01', '2026-09-07');
    const straddling = offer('2026-09-30', '2026-10-06');
    const inside = offer('2026-10-10', '2026-10-10');
    const after = offer('2026-11-01', '2026-11-02');
    const ids = listOvertimeVolunteersOverlapping(
      handle.db,
      unitId,
      isoDate('2026-10-01'),
      isoDate('2026-10-31'),
    ).map((v) => v.id);
    expect(ids).toEqual([straddling.id, inside.id]);
    expect(ids).not.toContain(before.id);
    expect(ids).not.toContain(after.id);
  });

  it('audits an edit with what it was before, and clears a note on null', () => {
    const v = offer('2026-10-05', '2026-10-11', 'texted');
    const updated = updateOvertimeVolunteer(
      handle.db,
      v.id,
      { endDate: isoDate('2026-10-14'), note: null },
      ACTOR,
    );
    expect(updated).toEqual({
      id: v.id,
      unitId,
      nurseId: ana.id,
      startDate: '2026-10-05',
      endDate: '2026-10-14',
    });
    const [entry] = auditHistoryFor(handle.db, 'overtime_volunteer', v.id);
    expect(entry).toMatchObject({ action: 'update', before: v, after: updated });
  });

  it('will not move an offer to another nurse or unit, or end it before it starts', () => {
    const v = offer('2026-10-05', '2026-10-11');
    expect(() =>
      updateOvertimeVolunteer(handle.db, v.id, { nurseId: stranger.id } as never, ACTOR),
    ).toThrow("cannot change 'nurseId'");
    expect(() =>
      updateOvertimeVolunteer(handle.db, v.id, { endDate: isoDate('2026-10-01') }, ACTOR),
    ).toThrow('The offer ends before it starts');
  });

  it('removes an offer and keeps its audit trail with the before', () => {
    const v = offer('2026-10-05', '2026-10-11');
    deleteOvertimeVolunteer(handle.db, v.id, ACTOR);
    expect(listOvertimeVolunteers(handle.db, unitId)).toEqual([]);
    const [entry] = auditHistoryFor(handle.db, 'overtime_volunteer', v.id);
    expect(entry).toMatchObject({ action: 'delete', before: v });
  });
});
