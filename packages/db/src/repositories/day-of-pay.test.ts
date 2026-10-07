/**
 * The day's pay events and the unit's pay settings. A premium recorded twice by mistake would be
 * paid twice, and a call-back of 80 hours is a typo for 8, so both are refused in words; every
 * change is audited with its `before`, and the pricing events core reads come out as recorded.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createUnit } from './config.js';
import {
  createDayOfPayEvent,
  dayOfPayEventsOf,
  deleteDayOfPayEvent,
  listDayOfPayEvents,
  updateDayOfPayEvent,
} from './day-of-pay.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { createNurseUnit } from './nurse-units.js';
import { getPaySettings, savePaySettings } from './pay.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let ana: Nurse;

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
    expect(() => createDayOfPayEvent(handle.db, entry, ACTOR)).toThrow('not on this unit');
    createNurseUnit(handle.db, { nurseId: fran.id, unitId }, ACTOR);
    expect(() => createDayOfPayEvent(handle.db, entry, ACTOR)).not.toThrow();
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
    expect(() =>
      createDayOfPayEvent(
        handle.db,
        { kind: 'call_back', unitId, nurseId: ana.id, date: day, hoursWorked: 0 },
        ACTOR,
      ),
    ).toThrow('Enter the hours the call-back worked');
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

  it('removes an event and audits the delete with its before', () => {
    const e = createDayOfPayEvent(
      handle.db,
      { kind: 'call_back', unitId, nurseId: ana.id, date: day, hoursWorked: 2 },
      ACTOR,
    );
    deleteDayOfPayEvent(handle.db, e.id, ACTOR);
    expect(listDayOfPayEvents(handle.db, unitId, day, day)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'day_of_pay_event', e.id)[0]).toMatchObject({
      action: 'delete',
      before: { hoursWorked: 2 },
    });
  });
});

describe('the events core prices', () => {
  it('hands over each event as recorded, in date order, within the range asked for', () => {
    createDayOfPayEvent(
      handle.db,
      { kind: 'call_back', unitId, nurseId: ana.id, date: isoDate('2026-10-07'), hoursWorked: 2 },
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
    });
    savePaySettings(
      handle.db,
      unitId,
      { callBackMinimumHours: 4, premiumStacking: 'compound', holidayPayCoversOvertime: false },
      ACTOR,
    );
    savePaySettings(
      handle.db,
      unitId,
      { callBackMinimumHours: 3, premiumStacking: 'compound', holidayPayCoversOvertime: false },
      ACTOR,
    );
    expect(getPaySettings(handle.db, unitId)).toEqual({
      callBackMinimumHours: 3,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
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
      { callBackMinimumHours: 2, premiumStacking: 'additive', holidayPayCoversOvertime: false },
      ACTOR,
    );
    expect(getPaySettings(handle.db, unitId)).toEqual({
      callBackMinimumHours: 2,
      premiumStacking: 'additive',
      holidayPayCoversOvertime: false,
    });
    expect(auditHistoryFor(handle.db, 'pay_settings', unitId)[0]).toMatchObject({
      before: { premiumStacking: 'compound', holidayPayCoversOvertime: false },
      after: { premiumStacking: 'additive', holidayPayCoversOvertime: false },
    });
  });

  it('refuses a minimum a day cannot hold', () => {
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        { callBackMinimumHours: 30, premiumStacking: 'compound', holidayPayCoversOvertime: false },
        ACTOR,
      ),
    ).toThrow('between 0 and 24 hours');
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        { callBackMinimumHours: -1, premiumStacking: 'compound', holidayPayCoversOvertime: false },
        ACTOR,
      ),
    ).toThrow('between 0 and 24 hours');
  });
});
