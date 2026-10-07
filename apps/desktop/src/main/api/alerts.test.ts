/**
 * The publish preview's alerts as main builds them: the unit's per-diem commitment reaches the
 * compliance pass, and a unit with none gets no such alert.
 */

import { isoDate } from '@shiftnurse/core';
import {
  createHoliday,
  deleteHoliday,
  listHolidaysForUnit,
  listNursesForUnit,
  recordHolidayWork,
  transact,
  updateUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alertsFor } from './alerts.js';
import { ACTOR } from './context.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const commitmentAlerts = () =>
  alertsFor(f.handle.db, f.seeded.draftPeriodId).filter((a) => a.kind === 'per_diem_commitment');

describe('per-diem commitment alerts', () => {
  it('checks nothing while the unit has no commitment', () => {
    expect(commitmentAlerts()).toEqual([]);
  });

  // The scenario unit's five per-diem nurses, by first name (the seed is fixed, the ids are not).
  const PER_DIEM = ['Caleb', 'Chioma', 'Dalia', 'Ingrid', 'Wei'];
  const flaggedNames = () => {
    const first = new Map(
      listNursesForUnit(f.handle.db, f.seeded.unitId).map((n) => [n.id, n.firstName]),
    );
    return commitmentAlerts()
      .map((a) => first.get(a.nurseId!))
      .sort();
  };

  it('lists every per-diem nurse on an empty draft once the unit asks for weekend shifts', () => {
    updateUnit(
      f.handle.db,
      f.seeded.unitId,
      { perDiemCommitment: { weekendShiftsPer4Weeks: 2, holidayShiftsPerYear: 0 } },
      ACTOR,
    );
    expect(flaggedNames()).toEqual(PER_DIEM);
    expect(commitmentAlerts().every((a) => a.severity === 'warning')).toBe(true);
  });

  it('flags only the per-diem nurses who did not work the July holiday, in the period with the last one', () => {
    const { db } = f.handle;
    const unitId = f.seeded.unitId;
    // The draft (Sep 20 to Oct 31) must hold the year's last holiday: drop the two later ones.
    const holidays = listHolidaysForUnit(db, unitId);
    transact(db, (tx) => {
      for (const h of holidays.filter((x) => x.date.startsWith('2026-1'))) {
        deleteHoliday(tx, h.id, ACTOR);
      }
    });
    createHoliday(
      db,
      { unitId, date: isoDate('2026-10-20'), name: 'Year-end holiday', isMajor: false },
      ACTOR,
    );
    const july = holidays.find((h) => h.date === '2026-07-04')!;
    const dalia = listNursesForUnit(db, unitId).find((n) => n.firstName === 'Dalia')!;
    transact(db, (tx) => recordHolidayWork(tx, july.id, [dalia.id], ACTOR));
    updateUnit(
      db,
      unitId,
      { perDiemCommitment: { weekendShiftsPer4Weeks: 0, holidayShiftsPerYear: 1 } },
      ACTOR,
    );

    expect(flaggedNames()).toEqual(['Caleb', 'Chioma', 'Ingrid', 'Wei']);
    expect(commitmentAlerts()[0]!.message).toContain('2026');
  });
});
