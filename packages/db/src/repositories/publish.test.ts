/**
 * The publish lifecycle: a first publication freezes what went out, a republish carries a
 * reason and a real diff, and every post-publish edit lands in the change log with its
 * reason — the M12 acceptance check "publish, edit, and confirm the change log and audit
 * entries tell the full story", at the repository layer.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { getFairnessLedgerEntry } from './ledger.js';
import {
  changesSinceLastPublish,
  latestVersion,
  listChanges,
  listVersions,
  pendingDiff,
  publishSchedule,
  recordScheduleChange,
  requireChangeReason,
  requirePeriodEditable,
} from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import {
  createAssignment,
  createPeriod,
  deleteAssignment,
  getPeriod,
  listAssignmentsForPeriod,
} from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let periodId: string;
let shiftTypeId: string;
let ann: string;
let bo: string;

beforeEach(() => {
  handle = openTestDatabase();
  const db = handle.db;
  unitId = createUnit(
    db,
    {
      name: '4 West',
      unitType: 'Med-Surg',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  const ruleSet = saveRuleSet(
    db,
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
    db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#fff',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  const nurse = (employeeId: string, firstName: string) =>
    createNurse(
      db,
      {
        unitId,
        employeeId,
        firstName,
        lastName: 'Nurse',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: true,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    ).id;
  ann = nurse('E1', 'Ann');
  bo = nurse('E2', 'Bo');
  periodId = createPeriod(
    db,
    {
      unitId,
      name: 'PP1',
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
  createAssignment(db, { periodId, nurseId: ann, shiftTypeId, date: isoDate('2026-01-05') }, ACTOR);
  createAssignment(db, { periodId, nurseId: bo, shiftTypeId, date: isoDate('2026-01-06') }, ACTOR);
});

describe('publishSchedule', () => {
  it('freezes the assignments as version 1 and books the fairness ledger', () => {
    const result = publishSchedule(
      handle.db,
      {
        periodId,
        ledger: [{ nurseId: ann, periodId, periodStart: isoDate('2026-01-04'), totalHours: 12 }],
      },
      ACTOR,
    );
    expect(result.period.status).toBe('published');
    expect(result.period.publishedAt).toBeTypeOf('number');
    expect(result.version.version).toBe(1);
    expect(result.version.assignments).toHaveLength(2);
    expect(result.diff).toMatchObject({ added: 2, removed: 0, changed: 0 });
    expect(result.ledgerEntries).toBe(1);
    expect(getFairnessLedgerEntry(handle.db, ann, periodId)?.totalHours).toBe(12);
    expect(auditHistoryFor(handle.db, 'schedule_period', periodId)[0]?.action).toBe('publish');
  });

  it('refuses to republish without a reason, and refuses when nothing changed', () => {
    publishSchedule(handle.db, { periodId }, ACTOR);
    expect(() => publishSchedule(handle.db, { periodId }, ACTOR)).toThrow(/requires a reason/);
    expect(() => publishSchedule(handle.db, { periodId, reason: 'no-op' }, ACTOR)).toThrow(
      /Nothing has changed since version 1/,
    );
  });

  it('carries a post-publish move into version 2 as one removal and one addition', () => {
    const db = handle.db;
    publishSchedule(db, { periodId }, ACTOR);
    const period = getPeriod(db, periodId)!;
    const reason = requireChangeReason(period, "Ann's sick note for the 5th");
    const before = listAssignmentsForPeriod(db, periodId).find((a) => a.nurseId === ann)!;
    deleteAssignment(db, before.id, ACTOR, reason);
    recordScheduleChange(
      db,
      {
        periodId,
        kind: 'removed',
        assignmentId: before.id,
        nurseId: ann,
        date: isoDate('2026-01-05'),
        shiftTypeId,
        before,
        reason: reason!,
      },
      ACTOR,
    );
    const added = createAssignment(
      db,
      { periodId, nurseId: bo, shiftTypeId, date: isoDate('2026-01-05') },
      ACTOR,
    );
    recordScheduleChange(
      db,
      {
        periodId,
        kind: 'added',
        assignmentId: added.id,
        nurseId: bo,
        date: isoDate('2026-01-05'),
        shiftTypeId,
        after: added,
        reason: reason!,
      },
      ACTOR,
    );

    expect(changesSinceLastPublish(db, periodId).map((c) => c.kind)).toEqual(['added', 'removed']);
    expect(pendingDiff(db, periodId)).toMatchObject({ added: 1, removed: 1, changed: 0 });

    const v2 = publishSchedule(db, { periodId, reason: 'Cover for Ann' }, ACTOR);
    expect(v2.version.version).toBe(2);
    expect(v2.diff.affectedNurseIds.sort()).toEqual([ann, bo].sort());
    expect(listVersions(db, periodId).map((v) => v.version)).toEqual([1, 2]);
    expect(latestVersion(db, periodId)?.reason).toBe('Cover for Ann');
    // The edits belong to version 1; after republishing there is nothing pending.
    expect(changesSinceLastPublish(db, periodId)).toEqual([]);
    expect(listChanges(db, periodId)).toHaveLength(2);
    expect(listChanges(db, periodId).every((c) => c.version === 1)).toBe(true);
  });
});

describe('the change log', () => {
  it('needs no reason on a draft but refuses a blank one once published', () => {
    const draft = getPeriod(handle.db, periodId)!;
    expect(requireChangeReason(draft)).toBeUndefined();
    publishSchedule(handle.db, { periodId }, ACTOR);
    const published = getPeriod(handle.db, periodId)!;
    expect(() => requireChangeReason(published, '   ')).toThrow(/requires a reason/);
    expect(requireChangeReason(published, '  swap for clinic  ')).toBe('swap for clinic');
  });

  it('lets a draft or published schedule be edited but freezes an archived one', () => {
    // Locking a shift needs no reason, but it is still an edit: an archived period is the
    // record of what was worked and must not change, whatever the edit.
    expect(() => requirePeriodEditable(getPeriod(handle.db, periodId)!)).not.toThrow();
    publishSchedule(handle.db, { periodId }, ACTOR);
    expect(() => requirePeriodEditable(getPeriod(handle.db, periodId)!)).not.toThrow();
    const archived = { ...getPeriod(handle.db, periodId)!, status: 'archived' as const };
    expect(() => requirePeriodEditable(archived)).toThrow(/archived/);
  });

  it('refuses to log a change on a period that was never published', () => {
    expect(() =>
      recordScheduleChange(
        handle.db,
        {
          periodId,
          kind: 'added',
          assignmentId: 'asg_x',
          nurseId: ann,
          date: isoDate('2026-01-05'),
          shiftTypeId,
          reason: 'x',
        },
        ACTOR,
      ),
    ).toThrow(/never been published/);
  });

  it('writes a strict audit entry quoting the reason next to the change row', () => {
    publishSchedule(handle.db, { periodId }, ACTOR);
    const change = recordScheduleChange(
      handle.db,
      {
        periodId,
        kind: 'changed',
        assignmentId: 'asg_x',
        nurseId: ann,
        date: isoDate('2026-01-05'),
        shiftTypeId,
        reason: 'Made charge after Bo called out',
      },
      ACTOR,
    );
    const audit = auditHistoryFor(handle.db, 'schedule_change', change.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe('Made charge after Bo called out');
  });
});
