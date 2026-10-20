/**
 * Repository tests for schedule periods and assignments.
 *
 * These exercise the behaviour that is easy to get quietly wrong: the lookback tail that
 * feeds cross-period rest checks, and the locked-cell-preserving rewrite that regeneration
 * depends on to never clobber a manager's pinned decision.
 */

import { addDays, DEFAULT_FAIRNESS_WEIGHTS, type IsoDate, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { recordHoldover } from './holdovers.js';
import { publishSchedule } from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import {
  archivePeriod,
  type CreateAssignmentInput,
  type CreatePeriodInput,
  createAssignment,
  createPeriod,
  deleteAssignment,
  deleteDraftPeriod,
  getAssignment,
  getCurrentDraft,
  getPeriod,
  listAssignmentsForNurseInRange,
  listAssignmentsForPeriod,
  listPeriodsForUnit,
  moveAssignment,
  priorAssignmentsBefore,
  replaceAssignments,
  setLocked,
  setRequestsCloseOn,
  updateAssignment,
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
      employeeId: nextEmployeeId(),
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
  const ruleSet = transact(handle.db, (tx) =>
    saveRuleSet(
      tx,
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
    ),
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

  it('records when time-off requests close for a period, and can clear it again', () => {
    const period = createPeriod(handle.db, basePeriod({}), ACTOR);
    expect(getPeriod(handle.db, period.id)?.requestsCloseOn).toBeUndefined();
    setRequestsCloseOn(handle.db, period.id, isoDate('2026-01-01'), ACTOR);
    expect(getPeriod(handle.db, period.id)?.requestsCloseOn).toBe('2026-01-01');
    setRequestsCloseOn(handle.db, period.id, undefined, ACTOR);
    expect(getPeriod(handle.db, period.id)?.requestsCloseOn).toBeUndefined();
    const audit = auditHistoryFor(handle.db, 'schedule_period', period.id);
    expect(audit.filter((a) => a.action === 'update')).toHaveLength(2);
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

  it('deletes a draft but refuses to delete a published period', () => {
    const draft = createPeriod(handle.db, basePeriod(), ACTOR);
    deleteDraftPeriod(handle.db, draft.id, ACTOR);
    expect(getPeriod(handle.db, draft.id)).toBeUndefined();

    const published = createPeriod(handle.db, basePeriod({ name: 'Locked in' }), ACTOR);
    publishSchedule(handle.db, { periodId: published.id }, ACTOR);
    expect(() => deleteDraftPeriod(handle.db, published.id, ACTOR)).toThrow();
  });

  it('archives a published schedule with a reason, and refuses a draft or a blank reason', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    expect(() => archivePeriod(handle.db, period.id, ACTOR, 'Closed pay period')).toThrow(
      /only a published schedule can be archived/,
    );

    publishSchedule(handle.db, { periodId: period.id }, ACTOR);
    const auditBefore = auditHistoryFor(handle.db, 'schedule_period', period.id).length;
    expect(() => archivePeriod(handle.db, period.id, ACTOR, '   ')).toThrow(/requires a reason/);
    expect(getPeriod(handle.db, period.id)?.status).toBe('published');
    expect(auditHistoryFor(handle.db, 'schedule_period', period.id)).toHaveLength(auditBefore);

    const archived = archivePeriod(handle.db, period.id, ACTOR, 'Closed pay period');
    expect(archived.status).toBe('archived');
    const entry = auditHistoryFor(handle.db, 'schedule_period', period.id)[0]!;
    expect(entry.before).toMatchObject({ status: 'published' });
    expect(entry.after).toMatchObject({ status: 'archived' });
    expect(entry.reason).toBe('Closed pay period');

    const auditArchived = auditHistoryFor(handle.db, 'schedule_period', period.id).length;
    expect(() => archivePeriod(handle.db, period.id, ACTOR, 'Again')).toThrow(/already archived/);
    expect(auditHistoryFor(handle.db, 'schedule_period', period.id)).toHaveLength(auditArchived);
  });

  it('refuses to archive a schedule that does not exist, and records nothing', () => {
    const auditBefore = recentAudit(handle.db, 1000).length;
    expect(() => archivePeriod(handle.db, 'per_missing', ACTOR, 'Closed pay period')).toThrow(
      /not found/,
    );
    expect(recentAudit(handle.db, 1000)).toHaveLength(auditBefore);
  });

  it('refuses a period that ends before it starts, or a start that is not a date', () => {
    expect(() =>
      createPeriod(
        handle.db,
        basePeriod({ startDate: isoDate('2026-01-15'), endDate: isoDate('2026-01-14') }),
        ACTOR,
      ),
    ).toThrow(/ends before it starts/);
    expect(() =>
      createPeriod(handle.db, basePeriod({ startDate: 'soon' as IsoDate }), ACTOR),
    ).toThrow(/start date "soon" is not a date/);
    expect(() =>
      createPeriod(handle.db, basePeriod({ endDate: '2026-02-30' as IsoDate }), ACTOR),
    ).toThrow(/end date "2026-02-30" is not a date/);
    expect(listPeriodsForUnit(handle.db, unitId)).toHaveLength(0);

    const oneDay = createPeriod(
      handle.db,
      basePeriod({ startDate: isoDate('2026-01-15'), endDate: isoDate('2026-01-15') }),
      ACTOR,
    );
    expect(getPeriod(handle.db, oneDay.id)?.endDate).toBe('2026-01-15');
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

  it('refuses to move a shift through a patch — a date or shift change must be a move', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, isLocked: true }),
      ACTOR,
    );
    // The IPC boundary is typed, not checked: a payload can carry any key at runtime.
    const smuggled = { date: isoDate('2026-01-20') } as unknown as { isCharge: boolean };
    expect(() => updateAssignment(handle.db, created.id, smuggled, ACTOR)).toThrow(/date/);
    expect(listAssignmentsForPeriod(handle.db, period.id)[0]?.date).toBe('2026-01-15');
  });

  it('refuses a patch that would hand the shift to a different nurse', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const ada = mkNurse('Ada');
    const bea = mkNurse('Bea');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId: ada }),
      ACTOR,
    );
    const smuggled = { nurseId: bea } as unknown as { isCharge: boolean };
    expect(() => updateAssignment(handle.db, created.id, smuggled, ACTOR)).toThrow(/nurseId/);
    expect(listAssignmentsForPeriod(handle.db, period.id)[0]?.nurseId).toBe(ada);
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
    expect(deleteEntry).toMatchObject({
      before: { id: created.id, nurseId, isCharge: true },
    });
  });

  it('toggles lock, charge and overtime one field at a time', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId }),
      ACTOR,
    );
    expect(setLocked(handle.db, created.id, true, ACTOR).isLocked).toBe(true);
    expect(updateAssignment(handle.db, created.id, { isCharge: true }, ACTOR).isCharge).toBe(true);
    expect(updateAssignment(handle.db, created.id, { isOvertime: true }, ACTOR).isOvertime).toBe(
      true,
    );
  });
});

describe('placing a shift', () => {
  const auditCount = () => recentAudit(handle.db, 10000).length;

  it('refuses a shift dated outside its schedule, in words', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const before = auditCount();
    expect(() =>
      createAssignment(
        handle.db,
        baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-06-01') }),
        ACTOR,
      ),
    ).toThrow(/Mon Jun 1, 2026 is outside/);
    expect(listAssignmentsForPeriod(handle.db, period.id)).toHaveLength(0);
    expect(auditCount()).toBe(before);
  });

  it('refuses a date that is not a date', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    expect(() =>
      createAssignment(
        handle.db,
        baseAssignment({ periodId: period.id, nurseId, date: 'next tuesday' as IsoDate }),
        ACTOR,
      ),
    ).toThrow(/"next tuesday" is not a date/);
  });

  it("refuses another unit's shift type", () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const other = createUnit(
      handle.db,
      {
        name: '5 East',
        unitType: 'Medical-Surgical',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const foreign = createShiftType(
      handle.db,
      {
        unitId: other.id,
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
    expect(() =>
      createAssignment(
        handle.db,
        baseAssignment({ periodId: period.id, nurseId, shiftTypeId: foreign }),
        ACTOR,
      ),
    ).toThrow(/not one of this unit's shift types/);
  });

  it('refuses to move a shift out of its schedule', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-20') }),
      ACTOR,
    );
    expect(() =>
      transact(handle.db, (tx) =>
        moveAssignment(
          tx,
          created.id,
          { nurseId, shiftTypeId, date: isoDate('2026-01-29') },
          ACTOR,
        ),
      ),
    ).toThrow(/is outside/);
    expect(listAssignmentsForPeriod(handle.db, period.id).map((a) => a.id)).toEqual([created.id]);
  });

  it('refuses to move a shift with a recorded holdover and keeps the minutes', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const created = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-20') }),
      ACTOR,
    );
    publishSchedule(handle.db, { periodId: period.id }, ACTOR);
    recordHoldover(handle.db, { assignmentId: created.id, minutes: 90, mandated: false }, ACTOR);
    expect(() =>
      transact(handle.db, (tx) =>
        moveAssignment(
          tx,
          created.id,
          { nurseId, shiftTypeId, date: isoDate('2026-01-21') },
          ACTOR,
          'manual',
          'Nurse asked to swap days',
        ),
      ),
    ).toThrow(/90-minute holdover/);
    expect(getAssignment(handle.db, created.id)!.holdoverMinutes).toBe(90);
  });

  it('refuses solver output dated outside the schedule and deletes nothing', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const existing = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-16') }),
      ACTOR,
    );
    expect(() =>
      replaceAssignments(
        handle.db,
        period.id,
        [
          baseAssignment({ nurseId, date: isoDate('2026-01-17') }),
          baseAssignment({ nurseId, date: isoDate('2026-02-17') }),
        ],
        ACTOR,
      ),
    ).toThrow(/is outside/);
    expect(listAssignmentsForPeriod(handle.db, period.id).map((a) => a.id)).toEqual([existing.id]);
  });

  it("refuses solver output on another unit's shift type and deletes nothing", () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const existing = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-16') }),
      ACTOR,
    );
    const other = createUnit(
      handle.db,
      {
        name: '5 East',
        unitType: 'Medical-Surgical',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const foreign = createShiftType(
      handle.db,
      {
        unitId: other.id,
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
    expect(() =>
      replaceAssignments(
        handle.db,
        period.id,
        [baseAssignment({ nurseId, date: isoDate('2026-01-17'), shiftTypeId: foreign })],
        ACTOR,
      ),
    ).toThrow(/not one of this unit's shift types/);
    expect(listAssignmentsForPeriod(handle.db, period.id).map((a) => a.id)).toEqual([existing.id]);
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
    // 01-14 is outside the 01-15 period, so it lives in the period before it.
    const earlier = createPeriod(
      handle.db,
      basePeriod({
        name: 'Earlier',
        startDate: isoDate('2026-01-01'),
        endDate: isoDate('2026-01-14'),
      }),
      ACTOR,
    );
    createAssignment(
      handle.db,
      baseAssignment({ periodId: earlier.id, nurseId, date: isoDate('2026-01-14') }),
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
    publishSchedule(handle.db, { periodId: oldPeriod.id }, ACTOR);
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
    publishSchedule(handle.db, { periodId: oldPeriod.id }, ACTOR);
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

  it('keeps an archived pay period in the lookback: it is what was worked', () => {
    const oldPeriod = createPeriod(
      handle.db,
      basePeriod({ startDate: isoDate('2026-01-01'), endDate: isoDate('2026-01-14') }),
      ACTOR,
    );
    const nurseId = mkNurse('Ada');
    const lastDay = createAssignment(
      handle.db,
      baseAssignment({ periodId: oldPeriod.id, nurseId, date: isoDate('2026-01-14') }),
      ACTOR,
    );
    publishSchedule(handle.db, { periodId: oldPeriod.id }, ACTOR);
    archivePeriod(handle.db, oldPeriod.id, ACTOR, 'Pay period closed');

    const result = priorAssignmentsBefore(handle.db, unitId, newPeriodStart, 3);
    expect(result.map((a) => a.id)).toEqual([lastDay.id]);
  });

  it('excludes assignments on or after the start date itself', () => {
    const oldPeriod = createPeriod(
      handle.db,
      basePeriod({ startDate: isoDate('2026-01-01'), endDate: isoDate('2026-01-21') }),
      ACTOR,
    );
    publishSchedule(handle.db, { periodId: oldPeriod.id }, ACTOR);
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
  it('refuses to regenerate over a shift with a recorded holdover and deletes nothing', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurseId = mkNurse('Ada');
    const held = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId, date: isoDate('2026-01-20') }),
      ACTOR,
    );
    publishSchedule(handle.db, { periodId: period.id }, ACTOR);
    recordHoldover(handle.db, { assignmentId: held.id, minutes: 45, mandated: false }, ACTOR);
    expect(() => replaceAssignments(handle.db, period.id, [], ACTOR)).toThrow(/45-minute holdover/);
    expect(getAssignment(handle.db, held.id)!.holdoverMinutes).toBe(45);
  });

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

  it('keeps a record of who was on the grid before a regeneration wiped it', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const ada = mkNurse('Ada');
    const bea = mkNurse('Bea');
    const replaced = createAssignment(
      handle.db,
      baseAssignment({ periodId: period.id, nurseId: ada, date: isoDate('2026-01-17') }),
      ACTOR,
    );
    createAssignment(
      handle.db,
      baseAssignment({
        periodId: period.id,
        nurseId: bea,
        date: isoDate('2026-01-18'),
        isLocked: true,
      }),
      ACTOR,
    );
    replaceAssignments(handle.db, period.id, [], ACTOR);

    const generated = auditHistoryFor(handle.db, 'schedule_period', period.id).find(
      (e) => e.action === 'generate',
    );
    // Only Ada's unlocked shift was deleted; Bea's locked one survives and is not "before".
    expect(generated?.before).toEqual({
      removed: [{ id: replaced.id, nurseId: ada, date: '2026-01-17', shiftTypeId }],
    });
  });

  it('records which solver produced a generated schedule, and why it fell back', () => {
    const period = createPeriod(handle.db, basePeriod(), ACTOR);
    const nurse = mkNurse('Ada');
    replaceAssignments(
      handle.db,
      period.id,
      [baseAssignment({ periodId: period.id, nurseId: nurse, date: isoDate('2026-01-16') })],
      ACTOR,
      { solver: 'sa-lns', fellBackFrom: { solver: 'hybrid', reason: 'runner missing' } },
    );
    const generated = auditHistoryFor(handle.db, 'schedule_period', period.id).find(
      (e) => e.action === 'generate',
    );
    expect(generated?.after).toEqual({
      solver: 'sa-lns',
      fellBackFrom: { solver: 'hybrid', reason: 'runner missing' },
      created: 1,
      preservedLocked: 0,
    });
  });
});
