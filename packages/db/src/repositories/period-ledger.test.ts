/**
 * The ledger a publish books, built from a counting view: one row per nurse who worked, counted
 * by core's `deriveCounters` so the app, the history importer and the seeds agree on the burden.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, DEFAULT_WEEKEND, isoDate, ScheduleView } from '@shiftnurse/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit, listShiftTypesForUnit } from './config.js';
import { counterContextFor, periodLedgerRows } from './period-ledger.js';
import { createNurse, listNursesForUnit } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod, listAssignmentsForPeriod } from './schedule.js';
import { createTimeOffRequest, denyTimeOff } from './timeoff.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let ann: string;
let bea: string;
let cy: string;
let rows: ReturnType<typeof periodLedgerRows>;

beforeEach(() => {
  handle = openTestDatabase();
  const db = handle.db;
  const unitId = createUnit(
    db,
    {
      name: '4 West',
      unitType: 'Med-Surg',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  const ruleSet = transact(db, (tx) =>
    saveRuleSet(
      tx,
      {
        unitId,
        name: 'Default',
        weekendDefinition: DEFAULT_WEEKEND,
        fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
        configs: [],
      },
      ACTOR,
    ),
  );
  const shift = (name: string, abbreviation: string, startTime: string, isNight: boolean) =>
    createShiftType(
      db,
      {
        unitId,
        name,
        abbreviation,
        startTime,
        durationHours: 12,
        isNight,
        isOnCall: false,
        color: '#fff',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    ).id;
  const d12 = shift('Day 12', 'D12', '07:00', false);
  const n12 = shift('Night 12', 'N12', '19:00', true);
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
  bea = nurse('E2', 'Bea');
  cy = nurse('E3', 'Cy');
  const period = createPeriod(
    db,
    {
      unitId,
      name: 'P',
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  );
  const put = (nurseId: string, shiftTypeId: string, date: string, source?: 'callout') =>
    createAssignment(
      db,
      {
        periodId: period.id,
        nurseId,
        shiftTypeId,
        date: isoDate(date),
        ...(source ? { source } : {}),
      },
      ACTOR,
    );
  put(ann, d12, '2026-01-07');
  put(ann, n12, '2026-01-09');
  put(bea, d12, '2026-01-05', 'callout');
  const request = createTimeOffRequest(
    db,
    {
      nurseId: bea,
      startDate: isoDate('2026-01-12'),
      endDate: isoDate('2026-01-13'),
      type: 'pto',
    },
    ACTOR,
  );
  denyTimeOff(db, request.id, ACTOR, 'Two nurses already off');
  const schedule = new ScheduleView({
    period,
    assignments: listAssignmentsForPeriod(db, period.id),
    nurses: listNursesForUnit(db, unitId),
    shiftTypes: listShiftTypesForUnit(db, unitId),
  });
  rows = periodLedgerRows(
    schedule,
    counterContextFor(db, unitId, { ...DEFAULT_WEEKEND, mode: 'overlaps' }, period),
  );
});

describe('the ledger a publish books', () => {
  it('books a row for each nurse who worked and none for one who did not', () => {
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.nurseId))).toEqual(new Set([ann, bea]));
    expect(rows.some((r) => r.nurseId === cy)).toBe(false);
  });

  it('counts the Friday night as a weekend where the weekend is any shift that overlaps it', () => {
    // The N12 window [Fri 19:00, Sat 07:00) overlaps the weekend starting Saturday 00:00.
    expect(rows.find((r) => r.nurseId === ann)).toMatchObject({
      nightShifts: 1,
      weekendsWorked: 1,
      totalHours: 24,
      periodDays: 14,
      availableDays: 14,
    });
  });

  it("counts a denied request and a covered call-out on the nurse's row", () => {
    expect(rows.find((r) => r.nurseId === bea)).toMatchObject({
      requestsDenied: 1,
      callOutsCovered: 1,
      nightShifts: 0,
      totalHours: 12,
    });
  });
});
