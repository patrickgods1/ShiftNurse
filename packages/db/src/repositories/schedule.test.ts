/**
 * Repository tests for schedule periods and assignments.
 *
 * These exercise the behaviour that is easy to get quietly wrong: the lookback tail that
 * feeds cross-period rest checks, and the locked-cell-preserving rewrite that regeneration
 * depends on to never clobber a manager's pinned decision.
 */

import { addDays, DEFAULT_FAIRNESS_WEIGHTS, type IsoDate, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createShiftType, createUnit, saveRuleSet } from './config.js';
import { createNurse } from './roster.js';
import {
  type CreateAssignmentInput,
  type CreatePeriodInput,
  createAssignment,
  createPeriod,
  deleteAssignment,
  deleteDraftPeriod,
  getCurrentDraft,
  getPeriod,
  listAssignmentsForNurseInRange,
  listAssignmentsForPeriod,
  listPeriodsForUnit,
  priorAssignmentsBefore,
  publishPeriod,
  replaceAssignments,
  setCharge,
  setLocked,
  setOvertime,
  updateAssignment,
  updatePeriodStatus,
} from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let ruleSetId: string;
let ruleSetVersion: number;
let shiftTypeId: string;

function weekendDefinition() {
  return {
    startWeekday: 6 as const,
    startMinute: 0,
    durationMinutes: 2880,
    mode: 'starts_within' as const,
  };
}

function basePeriod(overrides: Partial<CreatePeriodInput> = {}): CreatePeriodInput {
  return {
    unitId,
    name: 'Test Period',
    startDate: isoDate('2026-01-15'),
    endDate: isoDate('2026-01-28'),
    ruleSetId,
    ruleSetVersion,
    ...overrides,
  };
}

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

function baseAssignment(overrides: Partial<CreateAssignmentInput> = {}): CreateAssignmentInput {
  return {
    periodId: '',
    nurseId: '',
    shiftTypeId,
    date: isoDate('2026-01-15'),
    ...overrides,
  };
}

beforeEach(() => {
  handle = openTestDatabase();
  const unit = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  unitId = unit.id;
  const ruleSet = saveRuleSet(
    handle.db,
    {
      unitId,
      name: 'Default',
      weekendDefinition: weekendDefinition(),
      fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
      configs: [
        {
          ruleId: 'min-rest-between-shifts',
          enabled: true,
          params: { minRestHours: 10, onCallCountsAsWork: false },
        },
      ],
    },
    ACTOR,
  );
  ruleSetId = ruleSet.id;
  ruleSetVersion = ruleSet.version;
  shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('periods', () => {
  it('creates a period, lists it for the unit, and finds it as the current draft', () => {
    const period = createPeriod(handle.db, basePeriod({ name: 'Pay Period 3' }), ACTOR);
    expect(period.status).toBe('draft');

    expect(getPeriod(handle.db, period.id)?.name).toBe('Pay Period 3');
    expect(getCurrentDraft(handle.db, unitId)?.id).toBe(period.id);
  });

  it('lists periods for a unit newest-first', () => {
    const older = createPeriod(
      handle.db,
      basePeriod({
        name: 'Older',
        startDate: isoDate('2026-01-01'),
        endDate: isoDate('2026-01-14'),
      }),
      ACTOR,
    );
    const newer = createPeriod(
      handle.db,
      basePeriod({
        name: 'Newer',
        startDate: isoDate('2026-02-01'),
        endDate: isoDate('2026-02-14'),
      }),
      ACTOR,
    );
    expect(listPeriodsForUnit(handle.db, unitId).map((p) => p.id)).toEqual([newer.id, older.id]);
  });

  it('publishing sets status and publishedAt, and records a publish audit entry', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    expect(period.publishedAt).toBeUndefined();

    const published = publishPeriod(handle.db, period.id, ACTOR, 'Ready for the floor');
    expect(published.status).toBe('published');
    expect(published.publishedAt).toBeTypeOf('number');

    const history = auditHistoryFor(handle.db, 'schedule_period', period.id);
    const publishEntry = history.find((h) => h.action === 'publish');
    expect(publishEntry).toBeDefined();
    expect(publishEntry?.reason).toBe('Ready for the floor');
  });

  it('deletes a draft but refuses to delete a published period', () => {
    const draft = createPeriod(handle.db, basePeriod(), ACTOR);
    deleteDraftPeriod(handle.db, draft.id, ACTOR);
    expect(getPeriod(handle.db, draft.id)).toBeUndefined();

    const published = createPeriod(handle.db, basePeriod({ name: 'Locked in' }), ACTOR);
    publishPeriod(handle.db, published.id, ACTOR);
    expect(() => deleteDraftPeriod(handle.db, published.id, ACTOR)).toThrow();
  });

  it('generic status updates are a distinct path from publish', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const archived = updatePeriodStatus(handle.db, period.id, 'archived', ACTOR);
    expect(archived.status).toBe('archived');
    expect(archived.publishedAt).toBeUndefined();
  });
});

describe('assignment CRUD', () => {
  it('creates, updates and deletes an assignment, recording audit at every step', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId }),
      ACTOR,
    );
    expect(listAssignmentsForPeriod(handle.db, period.id)).toHaveLength(1);

    const updated = updateAssignment(handle.db, created.id, { isCharge: true }, ACTOR);
    expect(updated.isCharge).toBe(true);

    deleteAssignment(handle.db, created.id, ACTOR);
    expect(listAssignmentsForPeriod(handle.db, period.id)).toHaveLength(0);
  });

  it('captures the deleted row as `before` — the only remaining record it ever existed', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, isCharge: true }),
      ACTOR,
    );
    deleteAssignment(handle.db, created.id, ACTOR);

    const history = auditHistoryFor(handle.db, 'assignment', created.id);
    const deleteEntry = history.find((h) => h.action === 'delete');
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry?.before).toMatchObject({
      id: created.id,
      nurseId,
      isCharge: true,
    });
  });

  it('setLocked, setCharge and setOvertime toggle their single field', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId }),
      ACTOR,
    );
    expect(setLocked(handle.db, created.id, true, ACTOR).isLocked).toBe(true);
    expect(setCharge(handle.db, created.id, true, ACTOR).isCharge).toBe(true);
    expect(setOvertime(handle.db, created.id, true, ACTOR).isOvertime).toBe(true);
  });
});

describe('listAssignmentsForNurseInRange', () => {
  it('is inclusive at both ends of the range', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const inRangeStart = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-15') }),
      ACTOR,
    );
    const inRangeEnd = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-21') }),
      ACTOR,
    );
    createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-14') }),
      ACTOR,
    );
    createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-22') }),
      ACTOR,
    );

    const inRange = listAssignmentsForNurseInRange(
      handle.db,
      nurseId,
      isoDate('2026-01-15'),
      isoDate('2026-01-21'),
    );
    expect(inRange.map((a) => a.id).sort()).toEqual([inRangeStart.id, inRangeEnd.id].sort());
  });
});

describe('priorAssignmentsBefore', () => {
  const newPeriodStart: IsoDate = isoDate('2026-01-15');

  it('returns published assignments inside the lookback window before the start date', () => {
    const oldPeriod = createPeriod(
      handle.db,
      basePeriod({ startDate: isoDate('2026-01-01'), endDate: isoDate('2026-01-14') }),
      ACTOR,
    );
    publishPeriod(handle.db, oldPeriod.id, ACTOR);
    const nurseId = mkNurse('Ada');
    const inWindow = createAssignment(
      handle.db,
      baseAssignment({ periodId: oldPeriod.id, nurseId, date: isoDate('2026-01-13') }),
      ACTOR,
    );

    const result = priorAssignmentsBefore(handle.db, unitId, newPeriodStart, 3);
    expect(result.map((a) => a.id)).toContain(inWindow.id);
  });

  it('excludes assignments belonging to a draft (unpublished) period', () => {
    const draftPeriod = createPeriod(
      handle.db,
      basePeriod({ startDate: isoDate('2026-01-01'), endDate: isoDate('2026-01-14') }),
      ACTOR,
    );
    // Left as draft — never published.
    const nurseId = mkNurse('Ada');
    createAssignment(
      handle.db,
      baseAssignment({ periodId: draftPeriod.id, nurseId, date: isoDate('2026-01-13') }),
      ACTOR,
    );

    const result = priorAssignmentsBefore(handle.db, unitId, newPeriodStart, 3);
    expect(result).toHaveLength(0);
  });

  it('respects the lookback day count, excluding dates further back', () => {
    const oldPeriod = createPeriod(
      handle.db,
      basePeriod({ startDate: isoDate('2025-12-20'), endDate: isoDate('2026-01-14') }),
      ACTOR,
    );
    publishPeriod(handle.db, oldPeriod.id, ACTOR);
    const nurseId = mkNurse('Ada');
    // lookbackDays = 2 => window is [2026-01-13, 2026-01-14].
    const tooEarly = createAssignment(
      handle.db,
      baseAssignment({ periodId: oldPeriod.id, nurseId, date: isoDate('2026-01-12') }),
      ACTOR,
    );
    const withinWindow = createAssignment(
      handle.db,
      baseAssignment({ periodId: oldPeriod.id, nurseId, date: isoDate('2026-01-13') }),
      ACTOR,
    );

    const result = priorAssignmentsBefore(handle.db, unitId, newPeriodStart, 2);
    const ids = result.map((a) => a.id);
    expect(ids).toContain(withinWindow.id);
    expect(ids).not.toContain(tooEarly.id);
  });

  it('excludes assignments on or after the start date itself', () => {
    const oldPeriod = createPeriod(
      handle.db,
      basePeriod({ startDate: isoDate('2026-01-01'), endDate: isoDate('2026-01-21') }),
      ACTOR,
    );
    publishPeriod(handle.db, oldPeriod.id, ACTOR);
    const nurseId = mkNurse('Ada');
    const onStart = createAssignment(
      handle.db,
      baseAssignment({ periodId: oldPeriod.id, nurseId, date: newPeriodStart }),
      ACTOR,
    );
    const afterStart = createAssignment(
      handle.db,
      baseAssignment({
        periodId: oldPeriod.id,
        nurseId,
        date: addDays(newPeriodStart, 1),
      }),
      ACTOR,
    );

    const result = priorAssignmentsBefore(handle.db, unitId, newPeriodStart, 5);
    const ids = result.map((a) => a.id);
    expect(ids).not.toContain(onStart.id);
    expect(ids).not.toContain(afterStart.id);
  });
});

describe('replaceAssignments', () => {
  it('replaces unlocked rows while leaving locked rows untouched, without unique-constraint errors', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const lockedNurse = mkNurse('Locked');
    const unlockedNurse = mkNurse('Unlocked');
    const freshNurse = mkNurse('Fresh');
    const lockedDate = isoDate('2026-01-16');

    const locked = createAssignment(
      handle.db,
      baseAssignment({
        periodId: period.id,
        nurseId: lockedNurse,
        date: lockedDate,
        isLocked: true,
      }),
      ACTOR,
    );
    const unlocked = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId: unlockedNurse, date: isoDate('2026-01-17') }),
      ACTOR,
    );

    // The solver's output echoes the locked cell back (it had to know the slot was occupied)
    // and also proposes a brand-new assignment. The echoed locked cell collides on
    // (nurseId, date, shiftTypeId) with the row already on disk.
    const result = replaceAssignments(
      handle.db,
      period.id,
      [
        baseAssignment({
          periodId: period.id,
          nurseId: lockedNurse,
          date: lockedDate,
          isLocked: true,
        }),
        baseAssignment({ periodId: period.id, nurseId: freshNurse, date: isoDate('2026-01-18') }),
      ],
      ACTOR,
    );

    const remaining = listAssignmentsForPeriod(handle.db, period.id);
    expect(remaining).toHaveLength(2);
    expect(remaining.find((a) => a.id === locked.id)).toBeDefined();
    expect(remaining.find((a) => a.nurseId === unlockedNurse)).toBeUndefined();
    expect(remaining.find((a) => a.nurseId === freshNurse)).toBeDefined();

    expect(result.find((a) => a.id === locked.id)?.isLocked).toBe(true);
    void unlocked;
  });
});
