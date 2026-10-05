/**
 * The float pool through the IPC handlers: each write lands with its audit row, a nurse's shifts
 * on another unit count against their rest here (so the grid flags a night on 5 West followed by a
 * day on this unit), and a nurse floated in from 5 West can be put on this unit's grid and judged
 * there without the view refusing a nurse it does not know.
 */

import { addDays, defaultRuleSet, isoDate } from '@shiftnurse/core';
import {
  auditHistoryFor,
  createAssignment,
  createNurse,
  createPeriod,
  createShiftType,
  createUnit,
  getPeriod,
  saveRuleSet,
  transact,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nurseUnitsApi } from './nurse-units.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const api = () => nurseUnitsApi(f.handle.db);

/** 5 West with a 19:00 night and a draft over the same dates as the fixture's. */
function westWing() {
  const { db } = f.handle;
  const west = createUnit(
    db,
    { name: '5 West', unitType: 'ICU', payPeriodDays: 14, payPeriodAnchor: isoDate('2026-01-04') },
    'manager',
  );
  const night = createShiftType(
    db,
    {
      unitId: west.id,
      name: 'Night 12',
      abbreviation: 'N12',
      startTime: '19:00',
      durationHours: 12,
      isNight: true,
      isOnCall: false,
      color: '#000',
      sortOrder: 1,
      active: true,
    },
    'manager',
  );
  const rules = transact(db, (tx) => saveRuleSet(tx, defaultRuleSet(west.id), 'manager'));
  const home = getPeriod(db, f.seeded.draftPeriodId)!;
  const period = createPeriod(
    db,
    {
      unitId: west.id,
      name: 'West',
      startDate: home.startDate,
      endDate: home.endDate,
      ruleSetId: rules.id,
      ruleSetVersion: rules.version,
    },
    'manager',
  );
  return { west, night, period };
}

const restBreaches = () =>
  scheduleApi(f.handle.db)
    .validate(f.seeded.draftPeriodId)
    .result.violations.filter((v) => v.code === 'insufficient_rest');

describe('recording where a nurse floats', () => {
  it('writes the membership with its audit row, and lists the nurse among those floating in', () => {
    const { west } = westWing();
    const fran = createNurse(
      f.handle.db,
      {
        unitId: west.id,
        employeeId: 'W-1',
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
      'manager',
    );
    const m = api().create({
      nurseId: fran.id,
      unitId: f.seeded.unitId,
      competency: 'Med-surg',
    });
    expect(auditHistoryFor(f.handle.db, 'nurse_unit', m.id)[0]).toMatchObject({
      action: 'create',
      actor: 'manager',
    });
    expect(api().forNurse(fran.id)).toEqual([m]);
    expect(
      api()
        .floatingIn(f.seeded.unitId)
        .map((n) => n.id),
    ).toEqual([fran.id]);
  });
});

describe('the grid with a nurse who works two units', () => {
  it('flags a day shift here that follows a night on 5 West with no rest between', () => {
    const { night, period } = westWing();
    const date = addDays(f.seeded.draftStart, 3);
    createAssignment(
      f.handle.db,
      { periodId: period.id, nurseId: f.rns[0]!.id, shiftTypeId: night.id, date },
      'manager',
    );
    expect(restBreaches()).toEqual([]);
    const next = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(date, 1),
    });
    const breaches = restBreaches();
    expect(breaches).toHaveLength(1);
    // The other unit's night is named in the finding too: it is one half of the short rest.
    expect(breaches[0]!.assignmentIds).toContain(next.id);
  });

  it('judges a nurse floated in from 5 West on this unit’s grid, rest across both units included', () => {
    const { west, night, period } = westWing();
    const fran = createNurse(
      f.handle.db,
      {
        unitId: west.id,
        employeeId: 'W-2',
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
      'manager',
    );
    api().create({ nurseId: fran.id, unitId: f.seeded.unitId });
    const date = addDays(f.seeded.draftStart, 3);
    createAssignment(
      f.handle.db,
      { periodId: period.id, nurseId: fran.id, shiftTypeId: night.id, date },
      'manager',
    );
    const next = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: fran.id,
      shiftTypeId: f.day.id,
      date: addDays(date, 1),
    });
    const breaches = restBreaches();
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.assignmentIds).toContain(next.id);
  });

  it('refuses a shift for a float nurse whose membership ends before the period, in words', () => {
    const { west } = westWing();
    const fran = createNurse(
      f.handle.db,
      {
        unitId: west.id,
        employeeId: 'W-3',
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
      'manager',
    );
    // The membership ended a month before the draft and its lookback begin.
    api().create({
      nurseId: fran.id,
      unitId: f.seeded.unitId,
      endDate: addDays(f.seeded.draftStart, -45),
    });
    expect(
      api()
        .roster(f.seeded.draftPeriodId)
        .some((n) => n.id === fran.id),
    ).toBe(false);
    expect(() =>
      scheduleApi(f.handle.db).createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: fran.id,
        shiftTypeId: f.day.id,
        date: addDays(f.seeded.draftStart, 2),
      }),
    ).toThrow("Fran Float is not on this unit's roster for");

    // Nor may a home nurse's shift be moved onto them.
    const home = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 5),
    });
    expect(() =>
      scheduleApi(f.handle.db).moveAssignment({
        assignmentId: home.id,
        nurseId: fran.id,
        shiftTypeId: f.day.id,
        date: home.date,
      }),
    ).toThrow("Fran Float is not on this unit's roster for");
  });
});
