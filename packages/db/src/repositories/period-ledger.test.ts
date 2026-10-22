/**
 * The ledger a publish books, built from a counting view: one row per nurse who worked, counted
 * by core's `deriveCounters` so the app, the history importer and the seeds agree on the burden.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  type FairnessLedgerEntry,
  isoDate,
  ScheduleView,
  scoreFairness,
} from '@shiftnurse/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit, listShiftTypesForUnit } from './config.js';
import { counterContextFor, periodLedgerRows } from './period-ledger.js';
import { createNurse, deactivateNurse, listNursesForUnit } from './roster.js';
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
    { includeAvailableHomeNurses: false },
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

describe('the zero rows a publish books for nurses who were there and carried nothing', () => {
  const WEEKEND = { ...DEFAULT_WEEKEND, mode: 'overlaps' } as const;

  /** Four-West fixture: Ann works a night, the others are described per test. */
  function fixture() {
    const db = handle.db;
    const unit = (name: string) =>
      createUnit(
        db,
        { name, unitType: 'Med-Surg', payPeriodDays: 14, payPeriodAnchor: isoDate('2026-01-04') },
        ACTOR,
      ).id;
    const unitId = unit('4 West');
    const otherUnitId = unit('5 East');
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
    const n12 = createShiftType(
      db,
      {
        unitId,
        name: 'Night 12',
        abbreviation: 'N12',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: false,
        color: '#fff',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    ).id;
    const nurse = (id: string, home: string, extra: { hireDate?: string; active?: boolean } = {}) =>
      createNurse(
        db,
        {
          unitId: home,
          employeeId: id,
          firstName: id,
          lastName: 'Nurse',
          role: 'RN',
          employmentType: 'full_time',
          fte: 1,
          contractedHoursPerPeriod: 72,
          seniorityDate: isoDate('2020-01-01'),
          ...(extra.hireDate ? { hireDate: isoDate(extra.hireDate) } : {}),
          isChargeEligible: true,
          isNovice: false,
          isFloatEligible: true,
          active: extra.active ?? true,
        },
        ACTOR,
      ).id;
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
    const night = (nurseId: string, date: string) =>
      createAssignment(
        db,
        { periodId: period.id, nurseId, shiftTypeId: n12, date: isoDate(date) },
        ACTOR,
      );
    const rowsFor = (includeAvailableHomeNurses: boolean, extraNurseIds: string[] = []) => {
      const home = listNursesForUnit(db, unitId);
      const extras = extraNurseIds.map(
        (id) => listNursesForUnit(db, otherUnitId).find((n) => n.id === id)!,
      );
      const view = new ScheduleView({
        period,
        assignments: listAssignmentsForPeriod(db, period.id),
        nurses: [...home, ...extras],
        shiftTypes: listShiftTypesForUnit(db, unitId),
      });
      return periodLedgerRows(view, counterContextFor(db, unitId, WEEKEND, period), {
        includeAvailableHomeNurses,
      });
    };
    return { db, unitId, otherUnitId, nurse, night, rowsFor };
  }

  it('books zero burden for a home nurse who was there all fourteen days and worked nothing', () => {
    const f = fixture();
    const ann = f.nurse('E1', f.unitId);
    const bea = f.nurse('E2', f.unitId);
    const cy = f.nurse('E3', f.unitId);
    f.night(ann, '2026-01-09');
    f.night(bea, '2026-01-10');
    const row = f.rowsFor(true).find((r) => r.nurseId === cy);
    expect(row).toMatchObject({
      nightShifts: 0,
      weekendsWorked: 0,
      holidaysWorked: 0,
      onCallShifts: 0,
      totalHours: 0,
      overtimeHours: 0,
      periodDays: 14,
      availableDays: 14,
    });
  });

  it('gives a float whose home unit is elsewhere no row when she worked nothing here', () => {
    const f = fixture();
    const ann = f.nurse('E1', f.unitId);
    const flo = f.nurse('E9', f.otherUnitId);
    f.night(ann, '2026-01-09');
    const rows = f.rowsFor(true, [flo]);
    expect(rows.map((r) => r.nurseId)).toEqual([ann]);
  });

  it('counts only the five days after a nurse hired on the thirteenth', () => {
    const f = fixture();
    const ann = f.nurse('E1', f.unitId);
    const newHire = f.nurse('E4', f.unitId, { hireDate: '2026-01-13' });
    f.night(ann, '2026-01-09');
    // Day 10 of 14 is 13 Jan; the 13th through the 17th inclusive is 5 days.
    expect(f.rowsFor(true).find((r) => r.nurseId === newHire)).toMatchObject({
      availableDays: 5,
      periodDays: 14,
    });
  });

  it('gives an inactive home nurse no row, and no shiftless nurse gets one when the option is off', () => {
    const f = fixture();
    const ann = f.nurse('E1', f.unitId);
    const gone = f.nurse('E5', f.unitId);
    const idle = f.nurse('E6', f.unitId);
    f.night(ann, '2026-01-09');
    deactivateNurse(f.db, gone, ACTOR);
    expect(
      f
        .rowsFor(true)
        .map((r) => r.nurseId)
        .sort(),
    ).toEqual([ann, idle].sort());
    expect(f.rowsFor(false).map((r) => r.nurseId)).toEqual([ann]);
  });

  it('puts the nurse who carried nothing ahead of her colleague who worked the nights next time', () => {
    const f = fixture();
    const ann = f.nurse('E1', f.unitId);
    const idle = f.nurse('E3', f.unitId);
    for (const d of ['2026-01-05', '2026-01-06', '2026-01-09', '2026-01-10']) f.night(ann, d);
    const history: FairnessLedgerEntry[] = f.rowsFor(true).map((r, i) => ({
      id: `L${i}`,
      nightShifts: 0,
      weekendsWorked: 0,
      holidaysWorked: 0,
      onCallShifts: 0,
      undesirableShifts: 0,
      requestsApproved: 0,
      requestsDenied: 0,
      callOutsCovered: 0,
      totalHours: 0,
      overtimeHours: 0,
      preferenceHitRate: 0,
      availableDays: r.periodDays,
      ...r,
    }));
    const report = scoreFairness({
      nurses: listNursesForUnit(f.db, f.unitId),
      current: new Map(),
      history,
      scope: { asOf: isoDate('2026-01-18'), periodDays: 14, payPeriodDays: 14 },
      preferences: [],
    });
    const index = (id: string) => report.scores.find((s) => s.nurseId === id)!.burdenIndex;
    expect(index(idle)).toBeLessThan(index(ann));
    // Booked as zero she is measured against a fair share and sits below it; with no row she
    // would have no weight at all and read as a neutral zero.
    expect(index(idle)).toBeLessThan(0);
  });
});
