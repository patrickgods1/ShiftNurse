/**
 * The Title 22 staffing record as main builds it: which dates are on it, and who counts as
 * having worked. The census-and-ratio arithmetic is core's (`staffing-record.test.ts`); what is
 * asserted here is the filtering the database makes possible.
 */

import { addDays } from '@shiftnurse/core';
import {
  archivePeriod,
  createPeriod,
  listPeriodsForUnit,
  markFloatedOff,
  publishSchedule,
  transact,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { dayOfApi } from './dayof.js';
import { scheduleApi } from './schedule.js';
import { staffingRecordDocument, staffingRecordRows } from './staffing-record.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const date = () => addDays(f.seeded.draftStart, 4);

function placeThreeRns() {
  return f.rns.slice(0, 3).map((n) =>
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: n.id,
      shiftTypeId: f.day.id,
      date: date(),
    }),
  );
}

function publish() {
  transact(f.handle.db, (tx) =>
    publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
  );
}

/** RN actual on the day shift of `date()`, or undefined when the record has no such row. */
function rnActual(today = addDays(date(), 10)) {
  return staffingRecordRows(f.handle.db, f.seeded.unitId, date(), date(), today).find(
    (r) => r.shiftTypeId === f.day.id && r.role === 'RN',
  )?.actual;
}

describe('the staffing record main builds', () => {
  it('keeps a date an archived period covers when a draft overlaps it', () => {
    const db = f.handle.db;
    const dayBefore = addDays(f.seeded.draftStart, -1);
    const archived = listPeriodsForUnit(db, f.seeded.unitId).find((p) => p.endDate === dayBefore)!;
    archivePeriod(db, archived.id, ACTOR, 'Pay period closed');
    const draft = listPeriodsForUnit(db, f.seeded.unitId).find(
      (p) => p.id === f.seeded.draftPeriodId,
    )!;
    createPeriod(
      db,
      {
        unitId: f.seeded.unitId,
        name: 'Overlapping draft',
        startDate: dayBefore,
        endDate: f.seeded.draftStart,
        ruleSetId: draft.ruleSetId,
        ruleSetVersion: draft.ruleSetVersion,
      },
      ACTOR,
    );
    const rows = staffingRecordRows(db, f.seeded.unitId, dayBefore, dayBefore, f.seeded.draftStart);
    expect(rows.some((r) => r.shiftTypeId === f.day.id && r.role === 'RN')).toBe(true);
    expect(rows.find((r) => r.shiftTypeId === f.day.id && r.role === 'RN')!.actual).toBeGreaterThan(
      0,
    );
  });

  it('leaves out a date only a draft covers', () => {
    placeThreeRns();
    expect(rnActual()).toBeUndefined();
  });

  it('leaves out dates after today', () => {
    placeThreeRns();
    publish();
    expect(rnActual(addDays(date(), -1))).toBeUndefined();
    expect(rnActual(date())).toBe(3);
  });

  it('does not count a nurse whose call-off is open or uncovered', () => {
    const [first, second] = placeThreeRns();
    publish();
    expect(rnActual()).toBe(3);

    const callOff = dayOfApi(f.handle.db).reportCallOff(first!.id, 'sick');
    expect(rnActual()).toBe(2);

    dayOfApi(f.handle.db).markUncovered(callOff.id, 'Nobody could come in');
    expect(rnActual()).toBe(2);

    // A cancelled call-off means she came in after all.
    const other = dayOfApi(f.handle.db).reportCallOff(second!.id, 'sick');
    dayOfApi(f.handle.db).cancelCallOff(other.id, 'Felt better');
    expect(rnActual()).toBe(2);
  });

  it('does not count a nurse floated to another unit', () => {
    const rows = placeThreeRns();
    publish();
    transact(f.handle.db, (tx) => markFloatedOff(tx, rows[2]!.id, '4B Telemetry', ACTOR));
    expect(rnActual()).toBe(2);
  });

  it('names the unit, the regulation and the dates in the file, and clamps the end to today', () => {
    placeThreeRns();
    publish();
    const doc = staffingRecordDocument(
      f.handle.db,
      f.seeded.unitId,
      date(),
      addDays(date(), 30),
      date(),
      Date.UTC(2026, 9, 22, 14, 5),
    );
    expect(doc.csv).toContain('22 CCR § 70217(c)');
    expect(doc.csv).toContain(`${date()} to ${date()}`);
    expect(doc.csv).toContain('Exported 2026-10-22 14:05 UTC');
    expect(doc.csv).toContain('Date,Shift,Role,Census,Basis,Required,Actual,Variance');
    expect(doc.html).toContain('22 CCR § 70217(c)');
    expect(doc.baseName).toMatch(/^staffing-record-.+-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}$/);
  });
});
