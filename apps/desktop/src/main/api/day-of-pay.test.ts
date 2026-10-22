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
  createShiftType,
  createUnit,
  deletePayRate,
  listDayOfPayEvents,
  listPayRatesForUnit,
  schema,
  transact,
} from '@shiftnurse/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('pays a missed meal at the week’s regular rate, night differential included, once the unit says so', () => {
    const pat = nurseAtFifty();
    const cost = costApi(f.handle.db);
    // Only a $5 night differential, so the figures are hand sums.
    for (const d of cost.differentials(f.seeded.unitId)) cost.deleteDifferential(d.id);
    cost.createDifferential({
      unitId: f.seeded.unitId,
      kind: 'night',
      mode: 'flat',
      amount: 5,
      active: true,
    });
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: pat.id,
      shiftTypeId: f.night.id,
      date: date(),
    });
    record({
      kind: 'missed_break',
      unitId: f.seeded.unitId,
      nurseId: pat.id,
      date: date(),
      shiftTypeId: f.night.id,
      break: 'meal',
    });
    expect(report().dayOf.lines.map((l) => [l.kind, l.amount])).toEqual([['missed_meal', 50]]);
    cost.savePaySettings(f.seeded.unitId, {
      ...cost.paySettings(f.seeded.unitId),
      breakPremiumRate: 'regular',
      compTime: null,
    });
    // Her only shift that week is the night: every hour at $50 + $5, so the regular rate is $55.
    expect(report().dayOf.lines.map((l) => [l.kind, l.rate, l.amount])).toEqual([
      ['missed_meal', 55, 55],
    ]);
  });

  it('pays a missed meal dated a day she has no shift at the base rate, even in a week she worked', () => {
    const pat = nurseAtFifty();
    const cost = costApi(f.handle.db);
    for (const d of cost.differentials(f.seeded.unitId)) cost.deleteDifferential(d.id);
    cost.createDifferential({
      unitId: f.seeded.unitId,
      kind: 'night',
      mode: 'flat',
      amount: 5,
      active: true,
    });
    cost.savePaySettings(f.seeded.unitId, {
      ...cost.paySettings(f.seeded.unitId),
      breakPremiumRate: 'regular',
      compTime: null,
    });
    // Her night that week has a $55 regular rate, but nothing is dated the next day.
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: pat.id,
      shiftTypeId: f.night.id,
      date: date(),
    });
    record({
      kind: 'missed_break',
      unitId: f.seeded.unitId,
      nurseId: pat.id,
      date: addDays(date(), 1),
      break: 'meal',
    });
    expect(report().dayOf.lines.map((l) => [l.kind, l.rate, l.amount])).toEqual([
      ['missed_meal', 50, 50],
    ]);
  });

  it('pays a call-back the unit’s minimum hours when the nurse worked less', () => {
    const pat = nurseAtFifty();
    costApi(f.handle.db).savePaySettings(f.seeded.unitId, {
      callBackMinimumHours: 4,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock' as const,
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base' as const,
      compTime: null,
    });
    const standby = createShiftType(
      f.handle.db,
      {
        unitId: f.seeded.unitId,
        name: 'Standby night',
        abbreviation: 'SBN',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: true,
        color: '#333',
        sortOrder: 9,
        active: true,
      },
      'manager',
    );
    record({
      kind: 'call_back',
      unitId: f.seeded.unitId,
      nurseId: pat.id,
      date: date(),
      shiftTypeId: standby.id,
      startMinute: 180,
      hoursWorked: 2,
    });
    const [line] = report().dayOf.lines;
    // Two hours worked, four guaranteed, at the $50 base (the unit has no call-back differential).
    expect(line).toMatchObject({ kind: 'call_back', hours: 4, rate: 50, amount: 200 });
    expect(costApi(f.handle.db).paySettings(f.seeded.unitId)).toEqual({
      callBackMinimumHours: 4,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock' as const,
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base' as const,
      compTime: null,
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

  it('prices a missed break for a nurse who has since moved to another unit', () => {
    const pat = nurseAtFifty();
    record({
      kind: 'missed_break',
      unitId: f.seeded.unitId,
      nurseId: pat.id,
      date: date(),
      break: 'meal',
    });
    const west = createUnit(
      f.handle.db,
      {
        name: '5 West',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      'manager',
    );
    // The event row still points at her, but she is in neither the unit's roster nor a float.
    f.handle.db
      .update(schema.nurse)
      .set({ unitId: west.id })
      .where(eq(schema.nurse.id, pat.id))
      .run();
    const dayOf = report().dayOf;
    expect(dayOf.lines).toHaveLength(1);
    expect(dayOf.unpriced).toBe(0);
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
  // Reporting pay is owed only for a late cancellation (D13); pin the clock to an hour into the
  // 07:00 shift so the expectation does not depend on the day the suite runs.
  beforeEach(() => {
    const [y, m, d] = date().split('-').map(Number) as [number, number, number];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(y, m - 1, d, 8, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
    ).toThrow(/goes home before/);
    expect(listDayOfPayEvents(f.handle.db, f.seeded.unitId, date(), date())).toEqual([]);
  });
});
