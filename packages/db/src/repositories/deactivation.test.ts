/**
 * A nurse who leaves must leave the schedule too. Deactivation once only flipped `active`: her
 * future shifts stayed counted as staffed while the grid hid her row, so a shift looked covered
 * by somebody who was gone.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { deactivateNurseLiftingDrafts, futureShiftsFor } from './deactivation.js';
import { publishSchedule } from './publish.js';
import { createNurse, getNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import {
  archivePeriod,
  createAssignment,
  createPeriod,
  listAssignmentsForPeriod,
} from './schedule.js';

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

function shift(periodId: string, date: string): string {
  return createAssignment(
    handle.db,
    { periodId, nurseId, shiftTypeId, date: isoDate(date), source: 'manual' },
    ACTOR,
  ).id;
}

const deactivate = (fromDate: string) =>
  transact(handle.db, (tx) => deactivateNurseLiftingDrafts(tx, nurseId, isoDate(fromDate), ACTOR));
const auditCount = () => recentAudit(handle.db, 10_000).length;
const datesIn = (periodId: string) =>
  listAssignmentsForPeriod(handle.db, periodId).map((a) => a.date);

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

/** A published fortnight with Ada on Sat Feb 21, and a draft with her on Mar 5. */
function publishedAndDraft(): { published: string; draft: string } {
  const published = mkPeriod('Feb B', '2026-02-15', '2026-02-28');
  shift(published, '2026-02-21');
  transact(handle.db, (tx) => publishSchedule(tx, { periodId: published, ledger: [] }, ACTOR));
  const draft = mkPeriod('Mar A', '2026-03-01', '2026-03-14');
  shift(draft, '2026-03-05');
  return { published, draft };
}

describe('a nurse who leaves the unit', () => {
  it('takes her draft shifts from her last day on off the schedule and marks her inactive', () => {
    const draft = mkPeriod('Mar A', '2026-03-01', '2026-03-14');
    shift(draft, '2026-03-02');
    const fifth = shift(draft, '2026-03-05');
    const ninth = shift(draft, '2026-03-09');

    const { nurse, lifted } = deactivate('2026-03-05');

    expect(lifted.map((a) => a.date)).toEqual(['2026-03-05', '2026-03-09']);
    expect(datesIn(draft)).toEqual(['2026-03-02']);
    expect(nurse.active).toBe(false);
    expect(getNurse(handle.db, nurseId)?.active).toBe(false);
    for (const [id, date] of [
      [fifth, '2026-03-05'],
      [ninth, '2026-03-09'],
    ] as const) {
      const [entry] = auditHistoryFor(handle.db, 'assignment', id);
      expect(entry).toMatchObject({
        action: 'delete',
        reason: 'Lifted: Ada Nurse was deactivated',
      });
      expect((entry!.before as { date: string }).date).toBe(date);
    }
    const [nurseEntry] = auditHistoryFor(handle.db, 'nurse', nurseId);
    expect(nurseEntry!.action).toBe('update');
    expect((nurseEntry!.before as { active: boolean }).active).toBe(true);
    expect((nurseEntry!.after as { active: boolean }).active).toBe(false);
  });

  it('refuses while she holds a shift staff already have, and changes nothing', () => {
    const { draft } = publishedAndDraft();
    const before = auditCount();

    expect(() => deactivate('2026-02-20')).toThrow(
      /Ada Nurse still has 1 shift on published schedules, the first on Sat Feb 21 \(Night 12, /,
    );

    expect(datesIn(draft)).toEqual(['2026-03-05']);
    expect(getNurse(handle.db, nurseId)?.active).toBe(true);
    expect(auditCount()).toBe(before);
  });

  it('leaves shifts on an archived schedule alone', () => {
    const archived = mkPeriod('Feb B', '2026-02-15', '2026-02-28');
    shift(archived, '2026-02-21');
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: archived, ledger: [] }, ACTOR));
    transact(handle.db, (tx) => archivePeriod(tx, archived, ACTOR, 'Pay period closed'));

    const { lifted } = deactivate('2026-02-20');

    expect(lifted).toEqual([]);
    expect(datesIn(archived)).toEqual(['2026-02-21']);
    expect(getNurse(handle.db, nurseId)?.active).toBe(false);
  });

  it('says so when the nurse is already inactive', () => {
    deactivate('2026-03-01');
    const before = auditCount();
    expect(() => deactivate('2026-03-01')).toThrow(/Ada Nurse is already inactive\./);
    expect(auditCount()).toBe(before);
  });

  it('lists what deactivating would do, drafts and published apart, in date order', () => {
    const { published, draft } = publishedAndDraft();

    const shifts = futureShiftsFor(handle.db, nurseId, isoDate('2026-02-20'));

    expect(shifts).toMatchObject([
      {
        assignment: { date: '2026-02-21', periodId: published },
        periodName: 'Feb B',
        periodStatus: 'published',
        shiftTypeName: 'Night 12',
      },
      {
        assignment: { date: '2026-03-05', periodId: draft },
        periodName: 'Mar A',
        periodStatus: 'draft',
        shiftTypeName: 'Night 12',
      },
    ]);
  });
});
