/**
 * The publish preview's alerts as main builds them: the unit's per-diem commitment reaches the
 * compliance pass, and a unit with none gets no such alert.
 */

import { isoDate } from '@shiftnurse/core';
import {
  createHoliday,
  createOvertimeRule,
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
import { scheduleApi } from './schedule.js';
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

describe('overtime alerts', () => {
  const overtimeAlerts = () =>
    alertsFor(f.handle.db, f.seeded.draftPeriodId).filter((a) => a.kind === 'overtime');

  it('prices a 12-hour day under a daily-8 rule, which the weekly threshold never flags', () => {
    const nurse = f.rns[0]!;
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: nurse.id,
      shiftTypeId: f.day.id,
      date: f.seeded.draftStart,
    });
    // One 12-hour shift in a week is far under 40, and the unit has no overtime rule yet.
    expect(overtimeAlerts()).toEqual([]);

    transact(f.handle.db, (tx) =>
      createOvertimeRule(
        tx,
        {
          unitId: f.seeded.unitId,
          basis: 'daily',
          thresholdHours: 8,
          multiplier: 1.5,
          active: true,
        },
        ACTOR,
      ),
    );
    const alerts = overtimeAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ nurseId: nurse.id, hours: 12, overtimeHours: 4 });
  });
});
