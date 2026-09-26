/**
 * Approving leave must take the nurse off the draft grid in the same call. The decide dialog
 * shows "displaced shifts" on the premise that approval clears them; if approval only flipped
 * the status, the nurse would be rostered during approved vacation and the hard
 * `works_during_approved_time_off` rule would fire on the grid a week later.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import {
  createAssignment,
  createPeriod,
  listAssignmentsForPeriod,
  publishPeriod,
} from './schedule.js';
import { approveTimeOffAndLiftAssignments, createTimeOffRequest } from './timeoff.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let shiftTypeId: string;
let nurseId: string;
let ruleSetId: string;
let ruleSetVersion: number;

function mkPeriod(name: string, start: string, end: string): string {
  return createPeriod(
    handle.db,
    { unitId, name, startDate: isoDate(start), endDate: isoDate(end), ruleSetId, ruleSetVersion },
    ACTOR,
  ).id;
}

function shift(periodId: string, date: string, isLocked = false): string {
  return createAssignment(
    handle.db,
    { periodId, nurseId, shiftTypeId, date: isoDate(date), source: 'manual', isLocked },
    ACTOR,
  ).id;
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
  const ruleSet = saveRuleSet(
    handle.db,
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
  );
  ruleSetId = ruleSet.id;
  ruleSetVersion = ruleSet.version;
  shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Night 12',
      abbreviation: 'N12',
      startTime: '19:00',
      durationHours: 12,
      isNight: true,
      isOnCall: false,
      color: '#4c1d95',
      sortOrder: 2,
      active: true,
    },
    ACTOR,
  ).id;
  nurseId = createNurse(
    handle.db,
    {
      unitId,
      employeeId: 'E1',
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
});

afterEach(() => handle.close());

describe('approveTimeOffAndLiftAssignments', () => {
  it('takes the nurse off the draft shifts inside the approved weekend, and no others', () => {
    const periodId = mkPeriod('Jan A', '2026-01-15', '2026-01-28');
    shift(periodId, '2026-01-16');
    const sat = shift(periodId, '2026-01-17');
    const sun = shift(periodId, '2026-01-18');
    shift(periodId, '2026-01-19');
    const req = createTimeOffRequest(
      handle.db,
      { nurseId, startDate: isoDate('2026-01-17'), endDate: isoDate('2026-01-18'), type: 'pto' },
      ACTOR,
    );

    const result = transact(handle.db, (tx) => approveTimeOffAndLiftAssignments(tx, req.id, ACTOR));

    expect(result.request.status).toBe('approved');
    expect(result.lifted.map((a) => a.id).sort()).toEqual([sat, sun].sort());
    expect(listAssignmentsForPeriod(handle.db, periodId).map((a) => a.date)).toEqual([
      '2026-01-16',
      '2026-01-19',
    ]);
    // The lift is on the record against the assignment, quoting the request it made way for.
    const audit = auditHistoryFor(handle.db, 'assignment', sat);
    expect(audit.some((e) => e.action === 'delete' && e.reason?.includes(req.id))).toBe(true);
  });

  it('lifts a locked shift too — approved leave outranks the manager pin', () => {
    const periodId = mkPeriod('Jan A', '2026-01-15', '2026-01-28');
    shift(periodId, '2026-01-17', true);
    const req = createTimeOffRequest(
      handle.db,
      { nurseId, startDate: isoDate('2026-01-17'), endDate: isoDate('2026-01-17'), type: 'pto' },
      ACTOR,
    );
    const result = transact(handle.db, (tx) => approveTimeOffAndLiftAssignments(tx, req.id, ACTOR));
    expect(result.lifted).toHaveLength(1);
    expect(listAssignmentsForPeriod(handle.db, periodId)).toHaveLength(0);
  });

  it('leaves a published schedule alone and reports the shifts it did not touch', () => {
    const periodId = mkPeriod('Dec B', '2025-12-18', '2025-12-31');
    shift(periodId, '2025-12-24');
    publishPeriod(handle.db, periodId, ACTOR);
    const req = createTimeOffRequest(
      handle.db,
      { nurseId, startDate: isoDate('2025-12-24'), endDate: isoDate('2025-12-26'), type: 'pto' },
      ACTOR,
    );
    const result = transact(handle.db, (tx) => approveTimeOffAndLiftAssignments(tx, req.id, ACTOR));
    expect(result.request.status).toBe('approved');
    expect(result.lifted).toHaveLength(0);
    expect(result.stillRostered).toHaveLength(1);
    expect(listAssignmentsForPeriod(handle.db, periodId)).toHaveLength(1);
  });
});
