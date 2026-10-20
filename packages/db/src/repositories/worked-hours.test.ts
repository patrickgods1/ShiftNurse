/**
 * Hours a nurse actually worked, as the FMLA hours test and per-hour accrual read them: a
 * published or archived schedule's shifts on any unit, at each shift type's own length.
 */

import { defaultRuleSet, isoDate } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { assignment } from '../schema.js';
import { cancelCallOff, markCallOffUncovered, reportCallOff } from './calloffs.js';
import { createShiftType, createUnit } from './config.js';
import { publishSchedule } from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { archivePeriod, createAssignment, createPeriod } from './schedule.js';
import { workedShiftsForNurseInRange } from './worked-hours.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let nurseId: string;

const night = isoDate('2026-06-27');

function unitWithShift(name: string, shift: { durationHours: number; isOnCall: boolean }) {
  const { db } = handle;
  const unit = createUnit(
    db,
    { name, unitType: 'ICU', payPeriodDays: 14, payPeriodAnchor: isoDate('2026-01-04') },
    ACTOR,
  );
  const type = createShiftType(
    db,
    {
      unitId: unit.id,
      name: shift.isOnCall ? 'On call' : 'Night 12',
      abbreviation: shift.isOnCall ? 'OC' : 'N12',
      startTime: '19:00',
      durationHours: shift.durationHours,
      isNight: true,
      isOnCall: shift.isOnCall,
      color: '#000',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  );
  const rules = transact(db, (tx) => saveRuleSet(tx, defaultRuleSet(unit.id), ACTOR));
  const period = createPeriod(
    db,
    {
      unitId: unit.id,
      name: `${name} June`,
      startDate: isoDate('2026-06-21'),
      endDate: isoDate('2026-07-04'),
      ruleSetId: rules.id,
      ruleSetVersion: rules.version,
    },
    ACTOR,
  );
  createAssignment(db, { periodId: period.id, nurseId, shiftTypeId: type.id, date: night }, ACTOR);
  return { unit, type, period };
}

const worked = () =>
  workedShiftsForNurseInRange(handle.db, nurseId, isoDate('2026-01-01'), isoDate('2026-12-31'));

beforeEach(() => {
  handle = openTestDatabase();
  const home = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  nurseId = createNurse(
    handle.db,
    {
      unitId: home.id,
      employeeId: 'WH-1',
      firstName: 'Lena',
      lastName: 'Balance',
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
  ).id;
});
afterEach(() => handle.close());

describe('hours a nurse worked', () => {
  it('counts a 12-hour night worked on another unit at its own length', () => {
    const { period } = unitWithShift('5 West', { durationHours: 12, isOnCall: false });
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: period.id }, ACTOR));
    expect(worked()).toEqual([{ date: '2026-06-27', hours: 12 }]);
  });

  it('does not count a draft’s proposed shifts as worked', () => {
    unitWithShift('5 West', { durationHours: 12, isOnCall: false });
    expect(worked()).toEqual([]);
  });

  it('does not count on-call standby as worked', () => {
    const { period } = unitWithShift('5 West', { durationHours: 12, isOnCall: true });
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: period.id }, ACTOR));
    expect(worked()).toEqual([]);
  });

  it('counts an archived period’s shifts as worked', () => {
    const { period } = unitWithShift('5 West', { durationHours: 12, isOnCall: false });
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: period.id }, ACTOR));
    archivePeriod(handle.db, period.id, ACTOR, 'Closed pay period');
    expect(worked()).toEqual([{ date: '2026-06-27', hours: 12 }]);
  });

  it('leaves out shifts outside the dates asked about', () => {
    const { period } = unitWithShift('5 West', { durationHours: 12, isOnCall: false });
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: period.id }, ACTOR));
    expect(
      workedShiftsForNurseInRange(handle.db, nurseId, isoDate('2026-06-28'), isoDate('2026-12-31')),
    ).toEqual([]);
  });

  describe('a call-off that nobody covered', () => {
    const publishedAssignmentId = () => {
      const { period } = unitWithShift('5 West', { durationHours: 12, isOnCall: false });
      transact(handle.db, (tx) => publishSchedule(tx, { periodId: period.id }, ACTOR));
      return handle.db.select().from(assignment).where(eq(assignment.nurseId, nurseId)).get()!.id;
    };

    it('does not count a published shift the nurse called off from and nobody covered', () => {
      const callOff = reportCallOff(handle.db, publishedAssignmentId(), ACTOR, 'Sick');
      markCallOffUncovered(handle.db, callOff.id, ACTOR, 'No one answered');
      expect(worked()).toEqual([]);
    });

    it('counts the shift again when the call-off is withdrawn', () => {
      const callOff = reportCallOff(handle.db, publishedAssignmentId(), ACTOR, 'Sick');
      cancelCallOff(handle.db, callOff.id, ACTOR, 'Came in after all');
      expect(worked()).toEqual([{ date: '2026-06-27', hours: 12 }]);
    });

    it('does not count a call-off still open', () => {
      reportCallOff(handle.db, publishedAssignmentId(), ACTOR, 'Sick');
      expect(worked()).toEqual([]);
    });
  });
});
