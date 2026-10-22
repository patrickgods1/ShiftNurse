/**
 * The day's pay events and the unit's pay settings. A premium recorded twice by mistake would be
 * paid twice, and a call-back of 80 hours is a typo for 8, so both are refused in words; every
 * change is audited with its `before`, and the pricing events core reads come out as recorded.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import {
  createDayOfPayEvent,
  dayOfPayEventsForNurseOn,
  dayOfPayEventsOf,
  deleteDayOfPayEvent,
  listDayOfPayEvents,
  updateDayOfPayEvent,
} from './day-of-pay.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { createNurseUnit } from './nurse-units.js';
import { getPaySettings, savePaySettings } from './pay.js';
import { publishSchedule } from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let ana: Nurse;
let standbyId: string;
// Standby 19:00-07:00 on `day`, called back at 22:00 (180 minutes in).
let callBack: {
  kind: 'call_back';
  unitId: string;
  nurseId: string;
  date: ReturnType<typeof isoDate>;
  shiftTypeId: string;
  startMinute: number;
};

const mkUnit = (name: string) =>
  createUnit(
    handle.db,
    {
      name,
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );

const mkShiftType = (name: string, isOnCall: boolean, startTime: string): string =>
  createShiftType(
    handle.db,
    {
      unitId,
      name,
      abbreviation: name.slice(0, 3),
      startTime,
      durationHours: 12,
      isNight: false,
      isOnCall,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;

const mkNurse = (forUnit: string, firstName: string): Nurse =>
  createNurse(
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

beforeEach(() => {
  handle = openTestDatabase();
  unitId = mkUnit('4 West').id;
  ana = mkNurse(unitId, 'Ana');
  standbyId = mkShiftType('Standby', true, '19:00');
  callBack = {
    kind: 'call_back',
    unitId,
    nurseId: ana.id,
    date: day,
    shiftTypeId: standbyId,
    startMinute: 180,
  };
});
afterEach(() => handle.close());

const day = isoDate('2026-10-06');

describe('recording a missed break', () => {
  it('keeps the nurse, the day and the kind of break, and audits the entry', () => {
    const e = createDayOfPayEvent(
      handle.db,
      { kind: 'missed_break', unitId, nurseId: ana.id, date: day, break: 'meal' },
      ACTOR,
    );
    expect(listDayOfPayEvents(handle.db, unitId, day, day)).toEqual([e]);
    expect(e).toMatchObject({ kind: 'missed_break', break: 'meal', enteredBy: 'manager' });
    expect(auditHistoryFor(handle.db, 'day_of_pay_event', e.id)[0]).toMatchObject({
      action: 'create',
      actor: 'manager',
      after: { nurseId: ana.id },
    });
  });

  it('refuses a second missed meal for the same nurse and day, but allows the rest break', () => {
    const base = { kind: 'missed_break', unitId, nurseId: ana.id, date: day } as const;
    createDayOfPayEvent(handle.db, { ...base, break: 'meal' }, ACTOR);
    expect(() => createDayOfPayEvent(handle.db, { ...base, break: 'meal' }, ACTOR)).toThrow(
      'A missed meal break is already recorded for Ana Test that day',
    );
    expect(() => createDayOfPayEvent(handle.db, { ...base, break: 'rest' }, ACTOR)).not.toThrow();
  });

  it('refuses a nurse who is not on this unit, and accepts one floated in', () => {
    const west = mkUnit('5 West');
    const fran = mkNurse(west.id, 'Fran');
    const entry = {
      kind: 'missed_break',
      unitId,
      nurseId: fran.id,
      date: day,
      break: 'rest',
    } as const;
    expect(() => createDayOfPayEvent(handle.db, entry, ACTOR)).toThrow("not on 4 West's roster");
    createNurseUnit(handle.db, { nurseId: fran.id, unitId }, ACTOR);
    expect(() => createDayOfPayEvent(handle.db, entry, ACTOR)).not.toThrow();
  });

  it('pays one missed-meal premium a day even when she worked two units', () => {
    const west = mkUnit('5 West');
    const fran = mkNurse(west.id, 'Fran');
    createNurseUnit(
      handle.db,
      {
        nurseId: fran.id,
        unitId,
        startDate: isoDate('2026-03-01'),
        endDate: isoDate('2026-03-31'),
      },
      ACTOR,
    );
    const meal = (forUnit: string) =>
      ({
        kind: 'missed_break',
        unitId: forUnit,
        nurseId: fran.id,
        date: isoDate('2026-03-10'),
        break: 'meal',
      }) as const;
    createDayOfPayEvent(handle.db, meal(west.id), ACTOR);
    expect(() => createDayOfPayEvent(handle.db, meal(unitId), ACTOR)).toThrow(
      /already recorded for Fran Test that day on 5 West/,
    );
    expect(dayOfPayEventsForNurseOn(handle.db, fran.id, isoDate('2026-03-10'))).toHaveLength(1);
  });

  it('refuses a float’s missed break on a day outside her membership', () => {
    const fran = mkNurse(mkUnit('5 West').id, 'Fran');
    createNurseUnit(
      handle.db,
      {
        nurseId: fran.id,
        unitId,
        startDate: isoDate('2026-03-01'),
        endDate: isoDate('2026-03-31'),
      },
      ACTOR,
    );
    expect(() =>
      createDayOfPayEvent(
        handle.db,
        {
          kind: 'missed_break',
          unitId,
          nurseId: fran.id,
          date: isoDate('2026-04-10'),
          break: 'meal',
        },
        ACTOR,
      ),
    ).toThrow(/not on 4 West's roster on Fri Apr 10/);
  });
});

describe('recording a send-home and a call-back', () => {
  it('refuses a shift length or hours worked that cannot be a real shift', () => {
    const sent = { kind: 'sent_home', unitId, nurseId: ana.id, date: day } as const;
    expect(() => createDayOfPayEvent(handle.db, { ...sent, scheduledHours: 0 }, ACTOR)).toThrow(
      'scheduled hours must be more than 0',
    );
    expect(() =>
      createDayOfPayEvent(handle.db, { ...sent, scheduledHours: 12, hoursWorked: 80 }, ACTOR),
    ).toThrow('Hours worked must be between 0 and 24');
    expect(() => createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 0 }, ACTOR)).toThrow(
      'Enter the hours the call-back worked',
    );
  });

  it('refuses sending the same nurse home twice from one shift', () => {
    const sent = {
      kind: 'sent_home',
      unitId,
      nurseId: ana.id,
      date: day,
      scheduledHours: 12,
    } as const;
    createDayOfPayEvent(handle.db, sent, ACTOR);
    expect(() => createDayOfPayEvent(handle.db, sent, ACTOR)).toThrow(
      'already recorded as sent home from that shift',
    );
  });

  it('lets the real hours be filled in later, audited with what they were before', () => {
    const e = createDayOfPayEvent(
      handle.db,
      { kind: 'sent_home', unitId, nurseId: ana.id, date: day, scheduledHours: 12 },
      ACTOR,
    );
    expect(e.hoursWorked).toBe(0);
    const after = updateDayOfPayEvent(
      handle.db,
      e.id,
      { hoursWorked: 3, note: ' stayed to help ' },
      ACTOR,
    );
    expect(after).toMatchObject({ hoursWorked: 3, note: 'stayed to help' });
    expect(auditHistoryFor(handle.db, 'day_of_pay_event', e.id)[0]).toMatchObject({
      action: 'update',
      before: { hoursWorked: 0 },
    });
  });

  it('will not give a missed break hours, or change what happened', () => {
    const e = createDayOfPayEvent(
      handle.db,
      { kind: 'missed_break', unitId, nurseId: ana.id, date: day, break: 'meal' },
      ACTOR,
    );
    expect(() => updateDayOfPayEvent(handle.db, e.id, { hoursWorked: 1 }, ACTOR)).toThrow(
      'A missed break has no hours to change',
    );
    expect(() => updateDayOfPayEvent(handle.db, e.id, { date: day } as never, ACTOR)).toThrow(
      "cannot change 'date'",
    );
  });

  it('will not let a call-back be changed to no hours', () => {
    const e = createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 3 }, ACTOR);
    expect(() => updateDayOfPayEvent(handle.db, e.id, { hoursWorked: 0 }, ACTOR)).toThrow(
      'Enter the hours the call-back worked',
    );
    expect(listDayOfPayEvents(handle.db, unitId, day, day)[0]?.hoursWorked).toBe(3);
  });

  it('refuses a sent-home record that worked longer than the shift', () => {
    const sent = {
      kind: 'sent_home',
      unitId,
      nurseId: ana.id,
      date: day,
      scheduledHours: 12,
    } as const;
    const message =
      'Hours worked (13) cannot be more than the 12 scheduled; a nurse who worked past the shift was not sent home.';
    expect(() => createDayOfPayEvent(handle.db, { ...sent, hoursWorked: 13 }, ACTOR)).toThrow(
      message,
    );
    const e = createDayOfPayEvent(handle.db, { ...sent, hoursWorked: 4 }, ACTOR);
    expect(() => updateDayOfPayEvent(handle.db, e.id, { hoursWorked: 13 }, ACTOR)).toThrow(message);
    expect(listDayOfPayEvents(handle.db, unitId, day, day)[0]?.hoursWorked).toBe(4);
  });

  it('removes an event and audits the delete with its before', () => {
    const e = createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 2 }, ACTOR);
    deleteDayOfPayEvent(handle.db, e.id, ACTOR);
    expect(listDayOfPayEvents(handle.db, unitId, day, day)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'day_of_pay_event', e.id)[0]).toMatchObject({
      action: 'delete',
      before: { hoursWorked: 2 },
    });
  });
});

describe('a call-back has a time', () => {
  // Ana works the 07:00-19:00 Day 12 the morning after the 2026-10-06 standby, published.
  const publishDayShift = () => {
    const dayId = mkShiftType('Day 12', false, '07:00');
    const ruleSet = transact(handle.db, (tx) =>
      saveRuleSet(
        tx,
        {
          unitId,
          name: 'Default',
          weekendDefinition: {
            startWeekday: 6,
            startMinute: 0,
            durationMinutes: 2880,
            mode: 'starts_within',
          },
          fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
          configs: [],
        },
        ACTOR,
      ),
    );
    const periodId = createPeriod(
      handle.db,
      {
        unitId,
        name: 'October',
        startDate: isoDate('2026-10-04'),
        endDate: isoDate('2026-10-17'),
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    ).id;
    createAssignment(
      handle.db,
      { periodId, nurseId: ana.id, shiftTypeId: dayId, date: isoDate('2026-10-07') },
      ACTOR,
    );
    transact(handle.db, (tx) => publishSchedule(tx, { periodId, ledger: [] }, ACTOR));
  };

  it('asks for the time the call-back started', () => {
    const { startMinute: _, ...noTime } = callBack;
    expect(() => createDayOfPayEvent(handle.db, { ...noTime, hoursWorked: 2 }, ACTOR)).toThrow(
      'Enter the time the call-back started.',
    );
  });

  it('keeps the time and audits it', () => {
    const e = createDayOfPayEvent(
      handle.db,
      { ...callBack, hoursWorked: 3, startMinute: 420 },
      ACTOR,
    );
    expect(e.startMinute).toBe(420);
    expect(listDayOfPayEvents(handle.db, unitId, day, day)[0]?.startMinute).toBe(420);
    expect(auditHistoryFor(handle.db, 'day_of_pay_event', e.id)[0]).toMatchObject({
      action: 'create',
      after: { startMinute: 420 },
    });
  });

  it('refuses a start after the 12-hour on-call shift has ended', () => {
    const message = 'The call-back must start during the on-call shift (19:00–07:00).';
    expect(() =>
      createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 1, startMinute: 720 }, ACTOR),
    ).toThrow(message);
    expect(() =>
      createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 1, startMinute: -1 }, ACTOR),
    ).toThrow(message);
    expect(
      createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 1, startMinute: 719 }, ACTOR)
        .startMinute,
    ).toBe(719);
  });

  it('refuses a call-back that runs into the day shift she works next morning', () => {
    publishDayShift();
    // 06:00 for two hours runs to 08:00; the Day 12 starts at 07:00.
    expect(() =>
      createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 2, startMinute: 660 }, ACTOR),
    ).toThrow("The call-back overlaps Ana's Day 12 on");
  });

  it('accepts a call-back that is over before the day shift starts', () => {
    publishDayShift();
    // 02:00 for three hours is 05:00; and 06:00 for one hour ends exactly at 07:00 (half-open).
    expect(
      createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 3, startMinute: 420 }, ACTOR)
        .startMinute,
    ).toBe(420);
    expect(
      createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 1, startMinute: 660 }, ACTOR)
        .startMinute,
    ).toBe(660);
  });

  it('lets a note be fixed after a day shift is published over the call-back, but not the hours', () => {
    const e = createDayOfPayEvent(
      handle.db,
      { ...callBack, hoursWorked: 2, startMinute: 660 },
      ACTOR,
    );
    publishDayShift();
    expect(updateDayOfPayEvent(handle.db, e.id, { note: 'paged by charge' }, ACTOR).note).toBe(
      'paged by charge',
    );
    expect(() => updateDayOfPayEvent(handle.db, e.id, { hoursWorked: 3 }, ACTOR)).toThrow(
      "The call-back overlaps Ana's Day 12 on",
    );
  });

  it('lets an old call-back with no time have its note changed', () => {
    const e = createDayOfPayEvent(handle.db, { ...callBack, hoursWorked: 2 }, ACTOR);
    handle.sqlite.prepare('UPDATE day_of_pay_event SET start_minute = NULL WHERE id = ?').run(e.id);
    const after = updateDayOfPayEvent(handle.db, e.id, { note: 'paged at night' }, ACTOR);
    expect(after).toMatchObject({ note: 'paged at night' });
    expect(after.startMinute).toBeUndefined();
    expect(() => updateDayOfPayEvent(handle.db, e.id, { startMinute: 900 }, ACTOR)).toThrow(
      'must start during the on-call shift',
    );
    expect(updateDayOfPayEvent(handle.db, e.id, { startMinute: 60 }, ACTOR).startMinute).toBe(60);
  });
});

describe('the events core prices', () => {
  it('hands over each event as recorded, in date order, within the range asked for', () => {
    createDayOfPayEvent(
      handle.db,
      { ...callBack, date: isoDate('2026-10-07'), hoursWorked: 2 },
      ACTOR,
    );
    createDayOfPayEvent(
      handle.db,
      { kind: 'missed_break', unitId, nurseId: ana.id, date: day, break: 'rest' },
      ACTOR,
    );
    createDayOfPayEvent(
      handle.db,
      { kind: 'missed_break', unitId, nurseId: ana.id, date: isoDate('2026-12-01'), break: 'rest' },
      ACTOR,
    );
    expect(
      dayOfPayEventsOf(
        listDayOfPayEvents(handle.db, unitId, isoDate('2026-10-01'), isoDate('2026-10-31')),
      ),
    ).toEqual([
      { kind: 'missed_break', nurseId: ana.id, date: day, break: 'rest' },
      { kind: 'call_back', nurseId: ana.id, date: '2026-10-07', hoursWorked: 2 },
    ]);
  });
});

describe('the unit’s call-back minimum', () => {
  it('is zero until saved, then kept with the audit before and after', () => {
    expect(getPaySettings(handle.db, unitId)).toEqual({
      callBackMinimumHours: 0,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      // The default a unit that saved nothing is priced by (D17).
      overtimeWindowAttribution: 'clock',
    });
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 4,
        premiumStacking: 'compound',
        holidayPayCoversOvertime: false,
        reportingPayNoticeHours: 2,
        overtimeWindowAttribution: 'clock',
      },
      ACTOR,
    );
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 3,
        premiumStacking: 'compound',
        holidayPayCoversOvertime: false,
        reportingPayNoticeHours: 2,
        overtimeWindowAttribution: 'clock',
      },
      ACTOR,
    );
    expect(getPaySettings(handle.db, unitId)).toEqual({
      callBackMinimumHours: 3,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock',
    });
    expect(auditHistoryFor(handle.db, 'pay_settings', unitId)[0]).toMatchObject({
      before: { callBackMinimumHours: 4 },
      after: { callBackMinimumHours: 3 },
    });
  });

  it('keeps additive premium stacking beside the minimum, and audits the change', () => {
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 2,
        premiumStacking: 'additive',
        holidayPayCoversOvertime: false,
        reportingPayNoticeHours: 2,
        overtimeWindowAttribution: 'clock',
      },
      ACTOR,
    );
    expect(getPaySettings(handle.db, unitId)).toEqual({
      callBackMinimumHours: 2,
      premiumStacking: 'additive',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock',
    });
    const entry = auditHistoryFor(handle.db, 'pay_settings', unitId)[0];
    expect(entry).toMatchObject({
      action: 'create',
      after: { premiumStacking: 'additive', holidayPayCoversOvertime: false },
    });
    expect(entry?.before).toBeUndefined();
  });

  it('refuses a minimum a day cannot hold', () => {
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        {
          callBackMinimumHours: 30,
          premiumStacking: 'compound',
          holidayPayCoversOvertime: false,
          reportingPayNoticeHours: 2,
          overtimeWindowAttribution: 'clock',
        },
        ACTOR,
      ),
    ).toThrow('between 0 and 24 hours');
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        {
          callBackMinimumHours: -1,
          premiumStacking: 'compound',
          holidayPayCoversOvertime: false,
          reportingPayNoticeHours: 2,
          overtimeWindowAttribution: 'clock',
        },
        ACTOR,
      ),
    ).toThrow('between 0 and 24 hours');
  });
});
