/**
 * The publish preview's alerts as main builds them: the unit's per-diem commitment reaches the
 * compliance pass, and a unit with none gets no such alert.
 */

import { addDays, isoDate, type MaxHoursParams, resolveConfigs, weekdayOf } from '@shiftnurse/core';
import {
  adoptLatestRules,
  createHoliday,
  createNurse,
  createNurseUnit,
  createOvertimeRule,
  createUnit,
  deleteHoliday,
  grantCredential,
  listCredentials,
  listHolidaysForUnit,
  listNursesForUnit,
  recordHolidayWork,
  saveRuleSet,
  transact,
  updateUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alertsFor, previousWorkWeekFor } from './alerts.js';
import { ACTOR, periodOrThrow, ruleSetFor, scheduleViewFor } from './context.js';
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

describe('per-diem holiday commitment under the unit’s holiday attribution', () => {
  // The year's only holiday is on the draft's sixth day, and Dalia works the night before it:
  // 19:00 on day 5 to 07:00 on day 6, so 7 of its 12 hours (07:00 less 00:00 is 7) fall on the holiday.
  function dalia(attribution?: 'clock' | 'majority'): boolean {
    const { db } = f.handle;
    const unitId = f.seeded.unitId;
    transact(db, (tx) => {
      for (const h of listHolidaysForUnit(db, unitId)) deleteHoliday(tx, h.id, ACTOR);
    });
    const holidayDate = addDays(f.seeded.draftStart, 5);
    createHoliday(db, { unitId, date: holidayDate, name: 'Unit holiday', isMajor: false }, ACTOR);
    const nurse = listNursesForUnit(db, unitId).find((n) => n.firstName === 'Dalia')!;
    scheduleApi(db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: nurse.id,
      shiftTypeId: f.night.id,
      date: addDays(f.seeded.draftStart, 4),
    });
    updateUnit(
      db,
      unitId,
      {
        perDiemCommitment: { weekendShiftsPer4Weeks: 0, holidayShiftsPerYear: 1 },
        ...(attribution ? { holidayAttribution: attribution } : {}),
      },
      ACTOR,
    );
    return commitmentAlerts().some((a) => a.nurseId === nurse.id);
  }

  it('does not count the night before the holiday when shifts count for the day they start', () => {
    expect(dalia()).toBe(true);
  });

  it('counts the night before the holiday when each hour counts for the day it is worked', () => {
    expect(dalia('clock')).toBe(false);
  });

  it('counts the night before the holiday when the day holding most of it is the holiday', () => {
    // 5 hours on the 5th (19:00 to 24:00) against 7 on the 6th: the holiday holds most.
    expect(dalia('majority')).toBe(false);
  });
});

describe('in-lieu holiday alerts', () => {
  const inLieuAlerts = () =>
    alertsFor(f.handle.db, f.seeded.draftPeriodId).filter((a) => a.kind === 'in_lieu_holiday');

  // A full-time nurse working Monday to Thursday around a Friday holiday: Thursday is her holiday.
  function workMondayToThursdayAroundFridayHoliday() {
    const { db } = f.handle;
    const unitId = f.seeded.unitId;
    transact(db, (tx) => {
      for (const h of listHolidaysForUnit(db, unitId)) deleteHoliday(tx, h.id, ACTOR);
    });
    const monday = addDays(f.seeded.draftStart, (1 - weekdayOf(f.seeded.draftStart) + 7) % 7);
    const friday = addDays(monday, 4);
    createHoliday(db, { unitId, date: friday, name: 'Unit holiday', isMajor: false }, ACTOR);
    const nurse = f.rns.find((n) => n.employmentType === 'full_time')!;
    for (let i = 0; i < 4; i++) {
      scheduleApi(db).createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: nurse.id,
        shiftTypeId: f.day.id,
        date: addDays(monday, i),
      });
    }
    return { nurse, thursday: addDays(monday, 3) };
  }

  it('names the Thursday as the nurse’s holiday once the unit moves holidays federally', () => {
    const { nurse, thursday } = workMondayToThursdayAroundFridayHoliday();
    updateUnit(f.handle.db, f.seeded.unitId, { inLieuHolidays: 'federal' }, ACTOR);
    // The scenario's draft already holds other nurses' shifts, so judge only this nurse's.
    const found = inLieuAlerts().filter((a) => a.nurseId === nurse.id);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'information',
      date: thursday,
    });
    // Premium on the in-lieu day is unconfirmed, so the message asks how it is compensated.
    expect(found[0]!.message).toContain('record how it is compensated');
  });

  it('says nothing about in-lieu days while the unit leaves holidays where they fall', () => {
    workMondayToThursdayAroundFridayHoliday();
    expect(inLieuAlerts()).toEqual([]);
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

describe('credential alerts for a nurse floated in', () => {
  it('warns about a floated-in nurse’s ACLS lapsing during the period', () => {
    const { db } = f.handle;
    const start = f.seeded.draftStart;
    const west = createUnit(
      db,
      {
        name: '5 West',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const fran = createNurse(
      db,
      {
        unitId: west.id,
        employeeId: 'W-100',
        firstName: 'Fran',
        lastName: 'Float',
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
    createNurseUnit(
      db,
      { nurseId: fran.id, unitId: f.seeded.unitId, startDate: start, endDate: addDays(start, 13) },
      ACTOR,
    );
    const acls = listCredentials(db).find((c) => c.code === 'ACLS')!;
    grantCredential(
      db,
      { nurseId: fran.id, credentialId: acls.id, expiresOn: addDays(start, 5) },
      ACTOR,
    );
    scheduleApi(db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: fran.id,
      shiftTypeId: f.day.id,
      date: addDays(start, 7),
    });
    const lapsing = alertsFor(db, f.seeded.draftPeriodId).filter(
      (a) => a.kind === 'credential_expiry' && a.nurseId === fran.id,
    );
    expect(lapsing).toHaveLength(1);
  });
});

describe('the work week the last published schedule was judged under', () => {
  const previousFor = () => {
    const { db } = f.handle;
    const period = periodOrThrow(db, f.seeded.draftPeriodId);
    const params = resolveConfigs(ruleSetFor(db, period)).find(
      (c) => c.ruleId === 'max-hours-per-week',
    )!.params as unknown as MaxHoursParams;
    const schedule = scheduleViewFor(db, period, { lookback: true, floated: 'worked' });
    return previousWorkWeekFor(
      db,
      period,
      {
        workWeekStartsOn: params.workWeekStartsOn,
        workWeekStartMinute: params.workWeekStartMinute ?? 0,
      },
      schedule,
    );
  };

  it('is not passed on while the draft keeps the week the history was published under', () => {
    expect(previousFor()).toBeUndefined();
  });

  it('is the old week once the draft moves to a Saturday 19:00 week', () => {
    const { db } = f.handle;
    const current = ruleSetFor(db, periodOrThrow(db, f.seeded.draftPeriodId));
    transact(db, (tx) =>
      saveRuleSet(
        tx,
        {
          ...current,
          configs: current.configs.map((c) =>
            c.ruleId === 'max-hours-per-week'
              ? { ...c, params: { ...c.params, workWeekStartsOn: 6, workWeekStartMinute: 1140 } }
              : c,
          ),
        },
        ACTOR,
      ),
    );
    adoptLatestRules(db, f.seeded.draftPeriodId, ACTOR);
    // The frozen scenarios start the week at midnight Sunday.
    expect(previousFor()).toEqual({ workWeekStartsOn: 0, workWeekStartMinute: 0 });
  });
});
