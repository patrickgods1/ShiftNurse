/**
 * The day's pay through the IPC handlers: events recorded from Today reach the cost report as
 * their own section (priced beside the schedule, never in its total), a nurse sent home for low
 * census is recorded as sent home in the same transaction, and a nurse with no pay rate is counted
 * as unpriced rather than paid nothing.
 */

import { addDays, isoDate } from '@shiftnurse/core';
import {
  createNurse,
  createPayRate,
  deletePayRate,
  listDayOfPayEvents,
  listPayRatesForUnit,
  transact,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costApi } from './cost.js';
import { dayOfPayApi } from './day-of-pay.js';
import { dayOfApi } from './dayof.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const date = () => addDays(f.seeded.draftStart, 4);

/** A nurse on a flat $50 an hour of their own, so every figure below is a hand sum of 50. */
function nurseAtFifty() {
  return transact(f.handle.db, (tx) => {
    const nurse = createNurse(
      tx,
      {
        unitId: f.seeded.unitId,
        employeeId: 'PAY-1',
        firstName: 'Pat',
        lastName: 'Payne',
        role: 'RN',
        employmentType: 'per_diem',
        fte: 0,
        contractedHoursPerPeriod: 0,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: false,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      'manager',
    );
    createPayRate(
      tx,
      { nurseId: nurse.id, role: null, hourlyRate: 50, effectiveFrom: isoDate('2020-01-01') },
      'manager',
    );
    return nurse;
  });
}

const report = () => costApi(f.handle.db).report(f.seeded.draftPeriodId);
const record = (entry: Parameters<ReturnType<typeof dayOfPayApi>['record']>[0]) =>
  dayOfPayApi(f.handle.db).record(entry);

describe('the cost report’s day-of pay', () => {
  it('prices a missed meal and a missed rest break at an hour each, beside the schedule’s cost', () => {
    const pat = nurseAtFifty();
    const scheduleTotal = report().cost.totals.total;
    expect(report().dayOf).toMatchObject({ lines: [], total: 0, unpriced: 0 });
    for (const kind of ['meal', 'rest'] as const) {
      record({
        kind: 'missed_break',
        unitId: f.seeded.unitId,
        nurseId: pat.id,
        date: date(),
        shiftTypeId: f.day.id,
        break: kind,
      });
    }
    const after = report();
    expect(after.dayOf.total).toBe(100);
    expect(after.dayOf.lines.map((l) => [l.kind, l.hours, l.amount])).toEqual([
      ['missed_meal', 1, 50],
      ['missed_rest', 1, 50],
    ]);
    // The day's premiums never move what the schedule costs.
    expect(after.cost.totals.total).toBe(scheduleTotal);
  });

  it('pays a call-back the unit’s minimum hours when the nurse worked less', () => {
    const pat = nurseAtFifty();
    costApi(f.handle.db).savePaySettings(f.seeded.unitId, {
      callBackMinimumHours: 4,
      premiumStacking: 'compound',
    });
    record({
      kind: 'call_back',
      unitId: f.seeded.unitId,
      nurseId: pat.id,
      date: date(),
      hoursWorked: 2,
    });
    const [line] = report().dayOf.lines;
    // Two hours worked, four guaranteed, at the $50 base (the unit has no call-back differential).
    expect(line).toMatchObject({ kind: 'call_back', hours: 4, rate: 50, amount: 200 });
    expect(costApi(f.handle.db).paySettings(f.seeded.unitId)).toEqual({
      callBackMinimumHours: 4,
      premiumStacking: 'compound',
    });
  });

  it('counts an event for a nurse with no pay rate as unpriced, never as nothing owed', () => {
    const pat = nurseAtFifty();
    for (const rate of listPayRatesForUnit(f.handle.db, f.seeded.unitId)) {
      transact(f.handle.db, (tx) => deletePayRate(tx, rate.id, 'manager'));
    }
    record({
      kind: 'missed_break',
      unitId: f.seeded.unitId,
      nurseId: pat.id,
      date: date(),
      break: 'meal',
    });
    expect(report().dayOf).toMatchObject({ lines: [], total: 0, unpriced: 1 });
  });

  it('leaves out an event dated outside the period', () => {
    const pat = nurseAtFifty();
    record({
      kind: 'missed_break',
      unitId: f.seeded.unitId,
      nurseId: pat.id,
      date: addDays(f.seeded.draftStart, -30),
      break: 'meal',
    });
    expect(report().dayOf.lines).toEqual([]);
  });
});

describe('sending a nurse home for low census', () => {
  it('records them as sent home from a 12-hour shift with no hours worked, in the same transaction', () => {
    for (const nurse of f.rns) {
      scheduleApi(f.handle.db).createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: nurse.id,
        shiftTypeId: f.day.id,
        date: date(),
      });
    }
    const order = dayOfApi(f.handle.db).cancellationOrder(
      f.seeded.draftPeriodId,
      date(),
      f.day.id,
      'RN',
      [],
    ).order;
    const first = order[0]!;
    dayOfApi(f.handle.db).cancelForCensus(
      f.seeded.draftPeriodId,
      date(),
      f.day.id,
      'RN',
      [],
      first.nurseId,
    );
    const events = listDayOfPayEvents(f.handle.db, f.seeded.unitId, date(), date());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'sent_home',
      nurseId: first.nurseId,
      shiftTypeId: f.day.id,
      scheduledHours: 12,
      hoursWorked: 0,
    });
    // Half of 12 hours is 6, but reporting-time pay is capped at 4.
    expect(report().dayOf.lines.map((l) => [l.kind, l.hours])).toEqual([['reporting_pay', 4]]);
  });

  it('records nothing when the order refuses the cancellation', () => {
    for (const nurse of f.rns) {
      scheduleApi(f.handle.db).createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: nurse.id,
        shiftTypeId: f.day.id,
        date: date(),
      });
    }
    const order = dayOfApi(f.handle.db).cancellationOrder(
      f.seeded.draftPeriodId,
      date(),
      f.day.id,
      'RN',
      [],
    ).order;
    const second = order[1]!;
    expect(() =>
      dayOfApi(f.handle.db).cancelForCensus(
        f.seeded.draftPeriodId,
        date(),
        f.day.id,
        'RN',
        [],
        second.nurseId,
      ),
    ).toThrow();
    expect(listDayOfPayEvents(f.handle.db, f.seeded.unitId, date(), date())).toEqual([]);
  });
});
