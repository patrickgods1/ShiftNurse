/**
 * Repository tests for the auto-resolve policy and for applying a resolution.
 *
 * What is easy to get quietly wrong here: a unit with no saved policy must come back *off*; a
 * manual apply with no reason must touch nothing; a resolution must land whole or not at all;
 * and a stale resolution (its nurse already holds the shift) must be refused rather than
 * double-booked.
 */

import {
  DEFAULT_AUTO_RESOLVE_POLICY,
  DEFAULT_FAIRNESS_WEIGHTS,
  isoDate,
  type Resolution,
  type ResolutionImpact,
} from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit, saveRuleSet } from './config.js';
import { applyResolution, getConflictPolicy, saveConflictPolicy } from './conflicts.js';
import { createNurse } from './roster.js';
import {
  createAssignment,
  createPeriod,
  listAssignmentsForPeriod,
  publishPeriod,
} from './schedule.js';
import { createTimeOffRequest, getTimeOffRequest } from './timeoff.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let periodId: string;
let shiftTypeId: string;

function mkNurse(firstName: string): string {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: `E${Math.random().toString().slice(2, 8)}`,
      firstName,
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
}

const NO_IMPACT: ResolutionImpact = {
  coverage: { hardShortfallBefore: 1, hardShortfallAfter: 0, delta: -1 },
  fairness: { unitScoreBefore: 80, unitScoreAfter: 80, delta: 0, affected: [] },
  cost: { dollarsBefore: 1000, dollarsAfter: 1450, delta: 450, unpriced: false },
  softViolationsIntroduced: [],
  softViolationsCleared: [],
};

function resolution(actions: Resolution['actions'], kind: Resolution['kind']): Resolution {
  return {
    id: `res_${kind}`,
    conflictId: 'conf_sat_night',
    kind,
    title: 'Test resolution',
    description: 'Assign Ada to the Saturday night that is one RN short.',
    actions,
    impact: NO_IMPACT,
    score: 10,
    nurseIds: [],
  };
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
  periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Jan A',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('auto-resolve policy', () => {
  it('is off for a unit that never saved one', () => {
    expect(getConflictPolicy(handle.db, unitId)).toEqual(DEFAULT_AUTO_RESOLVE_POLICY);
    expect(getConflictPolicy(handle.db, unitId).enabled).toBe(false);
  });

  it('saves, then updates in place with the previous thresholds in the audit entry', () => {
    saveConflictPolicy(
      handle.db,
      unitId,
      { enabled: true, maxCostDelta: 500, maxFairnessDrop: 2 },
      ACTOR,
    );
    saveConflictPolicy(
      handle.db,
      unitId,
      { enabled: false, maxCostDelta: 250, maxFairnessDrop: 2 },
      ACTOR,
    );
    expect(getConflictPolicy(handle.db, unitId)).toEqual({
      enabled: false,
      maxCostDelta: 250,
      maxFairnessDrop: 2,
    });
    const history = auditHistoryFor(handle.db, 'conflict_policy', policyIdFor(unitId));
    expect(history.map((h) => h.action)).toEqual(['update', 'create']);
    expect(history[0]?.before).toMatchObject({ enabled: true, maxCostDelta: 500 });
  });

  it('refuses a negative threshold', () => {
    expect(() =>
      saveConflictPolicy(
        handle.db,
        unitId,
        { enabled: true, maxCostDelta: -1, maxFairnessDrop: 1 },
        ACTOR,
      ),
    ).toThrow(/zero or positive/);
  });
});

function policyIdFor(unit: string): string {
  const rows = handle.sqlite
    .prepare('select id from conflict_policy where unit_id = ?')
    .all(unit) as { id: string }[];
  return rows[0]!.id;
}

describe('applying a resolution', () => {
  it('creates the covering shift with source "resolution" and a resolve audit entry', () => {
    const ada = mkNurse('Ada');
    const res = resolution(
      [
        {
          type: 'create_assignment',
          nurseId: ada,
          shiftTypeId,
          date: isoDate('2026-01-17'),
          isCharge: false,
          isOvertime: false,
        },
      ],
      'assign_available',
    );
    transact(handle.db, (tx) =>
      applyResolution(tx, periodId, res, ACTOR, { auto: false, reason: 'Ada volunteered' }),
    );
    const rows = listAssignmentsForPeriod(handle.db, periodId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nurseId: ada, source: 'resolution', date: '2026-01-17' });
    const audit = auditHistoryFor(handle.db, 'conflict', 'conf_sat_night');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'resolve', reason: 'Ada volunteered' });
    expect(audit[0]?.after).toMatchObject({ id: 'res_assign_available', kind: 'assign_available' });
  });

  it('records an auto-applied resolution as auto_resolve quoting its own description', () => {
    const ada = mkNurse('Ada');
    const res = resolution(
      [
        {
          type: 'create_assignment',
          nurseId: ada,
          shiftTypeId,
          date: isoDate('2026-01-17'),
          isCharge: false,
          isOvertime: true,
        },
      ],
      'authorize_overtime',
    );
    applyResolution(handle.db, periodId, res, ACTOR, { auto: true });
    const audit = auditHistoryFor(handle.db, 'conflict', 'conf_sat_night');
    expect(audit[0]).toMatchObject({ action: 'auto_resolve', reason: res.description });
    expect(listAssignmentsForPeriod(handle.db, periodId)[0]?.isOvertime).toBe(true);
  });

  it('refuses a manual apply with no reason and writes nothing', () => {
    const ada = mkNurse('Ada');
    const res = resolution(
      [
        {
          type: 'create_assignment',
          nurseId: ada,
          shiftTypeId,
          date: isoDate('2026-01-17'),
          isCharge: false,
          isOvertime: false,
        },
      ],
      'assign_available',
    );
    expect(() =>
      applyResolution(handle.db, periodId, res, ACTOR, { auto: false, reason: '   ' }),
    ).toThrow(/requires a reason/);
    expect(listAssignmentsForPeriod(handle.db, periodId)).toHaveLength(0);
    expect(auditHistoryFor(handle.db, 'conflict', 'conf_sat_night')).toHaveLength(0);
  });

  it('refuses to double-book a nurse who already holds the shift', () => {
    const ada = mkNurse('Ada');
    createAssignment(
      handle.db,
      { periodId, nurseId: ada, shiftTypeId, date: isoDate('2026-01-17') },
      ACTOR,
    );
    const res = resolution(
      [
        {
          type: 'create_assignment',
          nurseId: ada,
          shiftTypeId,
          date: isoDate('2026-01-17'),
          isCharge: false,
          isOvertime: false,
        },
      ],
      'assign_available',
    );
    expect(() =>
      transact(handle.db, (tx) =>
        applyResolution(tx, periodId, res, ACTOR, { auto: false, reason: 'stale card' }),
      ),
    ).toThrow(/already holds/);
    // The transaction rolled the audit entry back with the refused write.
    expect(auditHistoryFor(handle.db, 'conflict', 'conf_sat_night')).toHaveLength(0);
  });

  it('moves a shift and denies a request in one go, rolling both back if either fails', () => {
    const ada = mkNurse('Ada');
    const bea = mkNurse('Bea');
    const moved = createAssignment(
      handle.db,
      { periodId, nurseId: ada, shiftTypeId, date: isoDate('2026-01-16'), isCharge: true },
      ACTOR,
    );
    const request = createTimeOffRequest(
      handle.db,
      {
        nurseId: bea,
        startDate: isoDate('2026-01-17'),
        endDate: isoDate('2026-01-17'),
        type: 'pto',
      },
      ACTOR,
    );
    const res = resolution(
      [
        {
          type: 'move_assignment',
          assignmentId: moved.id,
          toDate: isoDate('2026-01-17'),
          toShiftTypeId: shiftTypeId,
        },
        { type: 'deny_time_off', timeOffId: request.id },
      ],
      'deny_time_off',
    );
    transact(handle.db, (tx) =>
      applyResolution(tx, periodId, res, ACTOR, { auto: false, reason: 'Only legal cover' }),
    );
    const rows = listAssignmentsForPeriod(handle.db, periodId);
    expect(rows).toHaveLength(1);
    // Charge travels with the moved shift.
    expect(rows[0]).toMatchObject({ nurseId: ada, date: '2026-01-17', isCharge: true });
    expect(getTimeOffRequest(handle.db, request.id)).toMatchObject({
      status: 'denied',
      decisionReason: res.description,
    });

    // Same shape again, now against a vanished assignment: nothing must land.
    const stale = resolution(
      [
        {
          type: 'move_assignment',
          assignmentId: moved.id,
          toDate: isoDate('2026-01-18'),
          toShiftTypeId: shiftTypeId,
        },
      ],
      'move_assignment',
    );
    expect(() =>
      transact(handle.db, (tx) =>
        applyResolution(tx, periodId, stale, ACTOR, { auto: false, reason: 'again' }),
      ),
    ).toThrow(/no longer exists/);
    expect(auditHistoryFor(handle.db, 'conflict', 'conf_sat_night')).toHaveLength(1);
  });

  it('accepting a shortfall changes no row but goes on the record', () => {
    const res = resolution(
      [{ type: 'accept_shortfall', conflictId: 'conf_sat_night' }],
      'accept_shortfall',
    );
    applyResolution(handle.db, periodId, res, ACTOR, { auto: false, reason: 'Agency booked' });
    expect(listAssignmentsForPeriod(handle.db, periodId)).toHaveLength(0);
    expect(auditHistoryFor(handle.db, 'conflict', 'conf_sat_night')[0]?.reason).toBe(
      'Agency booked',
    );
  });

  it('refuses to touch a published period', () => {
    publishPeriod(handle.db, periodId, ACTOR);
    const res = resolution(
      [{ type: 'accept_shortfall', conflictId: 'conf_sat_night' }],
      'accept_shortfall',
    );
    expect(() =>
      applyResolution(handle.db, periodId, res, ACTOR, { auto: false, reason: 'x' }),
    ).toThrow(/only be applied to a draft/);
  });

  it('takes a nurse on approved leave off a locked shift, quoting the resolution', () => {
    const ada = mkNurse('Ada');
    const held = createAssignment(
      handle.db,
      {
        periodId,
        nurseId: ada,
        shiftTypeId,
        date: isoDate('2026-01-17'),
        source: 'manual',
        isLocked: true,
      },
      ACTOR,
    );
    transact(handle.db, (tx) =>
      applyResolution(
        tx,
        periodId,
        resolution([{ type: 'delete_assignment', assignmentId: held.id }], 'remove_assignment'),
        ACTOR,
        { auto: false, reason: 'Her PTO was approved after the draft was built' },
      ),
    );
    expect(listAssignmentsForPeriod(handle.db, periodId)).toHaveLength(0);
    const audit = auditHistoryFor(handle.db, 'assignment', held.id);
    expect(audit.some((e) => e.action === 'delete' && e.reason?.includes('Saturday night'))).toBe(
      true,
    );
  });
});
