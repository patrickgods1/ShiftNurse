/**
 * Holdovers: time worked past a published shift's end. A required one is a decision that can be
 * grieved, so it needs its reason; a draft or a standby shift has no worked end to hold past.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import * as s from '../schema.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { recordHoldover } from './holdovers.js';
import { publishSchedule } from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod, getAssignment } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let nurseId: string;
let dayId: string;
let standbyId: string;
let periodId: string;

function mkShiftType(name: string, isOnCall: boolean, sortOrder: number): string {
  return createShiftType(
    handle.db,
    {
      unitId,
      name,
      abbreviation: name.slice(0, 3),
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall,
      color: '#f59e0b',
      sortOrder,
      active: true,
    },
    ACTOR,
  ).id;
}

function shift(shiftTypeId = dayId) {
  return createAssignment(
    handle.db,
    { periodId, nurseId, shiftTypeId, date: isoDate('2026-01-16') },
    ACTOR,
  );
}

function publish() {
  publishSchedule(handle.db, { periodId, ledger: [] }, ACTOR);
}

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  dayId = mkShiftType('Day 12', false, 1);
  standbyId = mkShiftType('Standby', true, 2);
  nurseId = createNurse(
    handle.db,
    {
      unitId,
      employeeId: nextEmployeeId(),
      firstName: 'Ada',
      lastName: 'Nurse',
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
  periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Test Period',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('recording a holdover', () => {
  it('records a volunteered holdover on a published shift and audits what it replaced', () => {
    const a = shift();
    publish();
    const updated = recordHoldover(
      handle.db,
      { assignmentId: a.id, minutes: 90, mandated: false },
      ACTOR,
    );
    expect(updated).toMatchObject({ holdoverMinutes: 90, holdoverMandated: false });
    expect(getAssignment(handle.db, a.id)).toMatchObject({ holdoverMinutes: 90 });

    const entry = auditHistoryFor(handle.db, 'assignment', a.id)[0]!;
    expect(entry.action).toBe('update');
    expect(entry.before).toEqual({ holdoverMinutes: 0, holdoverMandated: null });
    expect(entry.after).toEqual({ holdoverMinutes: 90, holdoverMandated: false });
  });

  it('records a required holdover with the reason the manager gave', () => {
    const a = shift();
    publish();
    recordHoldover(
      handle.db,
      { assignmentId: a.id, minutes: 120, mandated: true, reason: ' Relief nurse never arrived ' },
      ACTOR,
    );
    const entry = auditHistoryFor(handle.db, 'assignment', a.id)[0]!;
    expect(entry.reason).toBe('Relief nurse never arrived');
    expect(getAssignment(handle.db, a.id)).toMatchObject({
      holdoverMinutes: 120,
      holdoverMandated: true,
    });
  });

  it('clears a holdover with zero minutes and remembers what it was', () => {
    const a = shift();
    publish();
    recordHoldover(handle.db, { assignmentId: a.id, minutes: 60, mandated: false }, ACTOR);
    const cleared = recordHoldover(
      handle.db,
      { assignmentId: a.id, minutes: 0, mandated: false },
      ACTOR,
    );
    expect(cleared).not.toHaveProperty('holdoverMinutes');
    expect(cleared).not.toHaveProperty('holdoverMandated');
    const row = handle.db.select().from(s.assignment).get()!;
    expect(row.holdoverMandated).toBeNull();
    expect(auditHistoryFor(handle.db, 'assignment', a.id)[0]!.before).toEqual({
      holdoverMinutes: 60,
      holdoverMandated: false,
    });
  });

  it('clears a required holdover without asking for a reason', () => {
    const a = shift();
    publish();
    recordHoldover(
      handle.db,
      { assignmentId: a.id, minutes: 60, mandated: true, reason: 'No relief' },
      ACTOR,
    );
    const cleared = recordHoldover(
      handle.db,
      { assignmentId: a.id, minutes: 0, mandated: true },
      ACTOR,
    );
    expect(cleared).not.toHaveProperty('holdoverMinutes');
    const entry = auditHistoryFor(handle.db, 'assignment', a.id)[0]!;
    expect(entry.before).toEqual({ holdoverMinutes: 60, holdoverMandated: true });
    expect(entry.reason).toBeUndefined();
  });

  it('leaves a shift with no holdover looking exactly as it did before holdovers existed', () => {
    const a = shift();
    const keys = Object.keys(getAssignment(handle.db, a.id)!);
    expect(keys).not.toContain('holdoverMinutes');
    expect(keys).not.toContain('holdoverMandated');
  });

  it('refuses a holdover on a draft schedule', () => {
    const a = shift();
    expect(() =>
      recordHoldover(handle.db, { assignmentId: a.id, minutes: 30, mandated: false }, ACTOR),
    ).toThrow(/recorded on a published shift/);
  });

  it('refuses a holdover on a standby shift', () => {
    const a = shift(standbyId);
    publish();
    expect(() =>
      recordHoldover(handle.db, { assignmentId: a.id, minutes: 30, mandated: false }, ACTOR),
    ).toThrow(/Standby is not worked time/);
  });

  it('refuses a shift that is not on the schedule', () => {
    expect(() =>
      recordHoldover(handle.db, { assignmentId: 'nope', minutes: 30, mandated: false }, ACTOR),
    ).toThrow(/not found/);
  });

  it('refuses a holdover longer than twelve hours or in part-minutes', () => {
    const a = shift();
    publish();
    for (const minutes of [721, 1.5, -5, Number.NaN]) {
      expect(() =>
        recordHoldover(handle.db, { assignmentId: a.id, minutes, mandated: false }, ACTOR),
      ).toThrow(/whole minutes/);
    }
    expect(
      recordHoldover(handle.db, { assignmentId: a.id, minutes: 720, mandated: false }, ACTOR)
        .holdoverMinutes,
    ).toBe(720);
  });

  it('refuses a required holdover with no reason and writes nothing', () => {
    const a = shift();
    publish();
    for (const reason of [undefined, '', '   ']) {
      expect(() =>
        recordHoldover(
          handle.db,
          {
            assignmentId: a.id,
            minutes: 60,
            mandated: true,
            ...(reason !== undefined ? { reason } : {}),
          },
          ACTOR,
        ),
      ).toThrow(/reason/);
    }
    expect(getAssignment(handle.db, a.id)).not.toHaveProperty('holdoverMinutes');
  });
});
