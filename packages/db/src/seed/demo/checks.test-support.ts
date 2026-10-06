/**
 * The checks every realistic demo must pass, shared by the per-unit test files. A demo is what
 * an evaluator judges the product by: a history that shows someone working the morning after a
 * night, or a next schedule Generate cannot fill, makes the app look broken when the data is to
 * blame. Each unit's own test file adds the facts that make that unit what it is.
 */

import {
  buildRuleContext,
  costSchedule,
  datesInRange,
  deriveDemand,
  evaluateSchedule,
  type IsoDate,
  ScheduleView,
  solve,
} from '@shiftnurse/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../../client.js';
import { paidSickCallsForUnit } from '../../repositories/calloffs.js';
import {
  getUnit,
  listHolidaysForUnit,
  listShiftCredentialRequirementsForUnit,
  listShiftTypesForUnit,
} from '../../repositories/config.js';
import { listIncompatibilityGroups } from '../../repositories/incompatibility.js';
import { listOvertimeVolunteers } from '../../repositories/overtime-volunteers.js';
import { listPreceptorships } from '../../repositories/preceptorships.js';
import {
  listCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
} from '../../repositories/roster.js';
import { getRuleSet } from '../../repositories/rulesets.js';
import {
  getPeriod,
  listAssignmentsForPeriod,
  listPeriodsForUnit,
} from '../../repositories/schedule.js';
import { costContext, demandInputs, loadPeriodInput } from '../../repositories/solve-input.js';
import { listTimeOffForUnit } from '../../repositories/timeoff.js';
import { type DemoId, seedDemoUnit } from '../demo.js';
import type { SeedResult } from '../types.js';
import { slow } from './slow.test-support.js';

/** Seeding six months of history takes about a second locally, several on a slow CI runner. */
const SEED_TIMEOUT_MS = 60_000;

export interface DemoFixture {
  handle: OpenedDatabase;
  result: SeedResult;
  count(sql: string): number;
  rows<T>(sql: string): T[];
}

/** Seed `demo` once for the file, as of `today`. */
export function useDemo(demo: DemoId, today: IsoDate): DemoFixture {
  const fixture = {} as DemoFixture;
  beforeAll(() => {
    fixture.handle = openTestDatabase();
    fixture.result = transact(fixture.handle.db, (tx) => seedDemoUnit(tx, { demo, today }));
    fixture.count = (sql) => (fixture.handle.sqlite.prepare(sql).get() as { n: number }).n;
    fixture.rows = <T>(sql: string) => fixture.handle.sqlite.prepare(sql).all() as T[];
  }, SEED_TIMEOUT_MS);
  afterAll(() => fixture.handle.close());
  return fixture;
}

/** Violations of one severity (hard unless asked) across every published pay period, by code. */
export function historyViolations(
  f: DemoFixture,
  severity: 'hard' | 'soft' = 'hard',
): Map<string, number> {
  const db = f.handle.db;
  const unit = getUnit(db, f.result.unitId)!;
  const nurses = listNursesForUnit(db, unit.id);
  const shiftTypes = listShiftTypesForUnit(db, unit.id);
  const byCode = new Map<string, number>();
  for (const period of listPeriodsForUnit(db, unit.id)) {
    if (period.status !== 'published') continue;
    const ruleSet = getRuleSet(db, period.ruleSetId)!;
    const view = new ScheduleView({
      period,
      assignments: listAssignmentsForPeriod(db, period.id),
      nurses,
      shiftTypes,
    });
    const ctx = buildRuleContext({
      unit,
      demand: deriveDemand(
        datesInRange(period.startDate, period.endDate),
        demandInputs(db, unit.id, period.startDate, period.endDate),
      ),
      nurses,
      shiftTypes,
      timeOff: listTimeOffForUnit(db, unit.id),
      credentials: listCredentials(db),
      nurseCredentials: listNurseCredentialsForUnit(db, unit.id),
      shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, unit.id),
      holidays: listHolidaysForUnit(db, unit.id),
      weekendDefinition: ruleSet.weekendDefinition,
      paidSickCalls: paidSickCallsForUnit(db, unit.id),
      incompatibilityGroups: listIncompatibilityGroups(db, unit.id),
      overtimeVolunteers: listOvertimeVolunteers(db, unit.id),
      preceptorships: listPreceptorships(db, unit.id),
    });
    const result = evaluateSchedule(view, ruleSet, ctx);
    for (const v of severity === 'hard' ? result.hardViolations : result.softViolations) {
      byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);
    }
  }
  return byCode;
}

/** The checks every demo shares; call inside the unit's `describe`. */
export function realisticDemoChecks(f: DemoFixture, demo: DemoId, today: IsoDate): void {
  it('never schedules anyone the morning after a night, on approved leave, or before their hire date', () => {
    const violations = historyViolations(f);
    // The rule engine's own codes: a misspelt one here would pass for ever.
    for (const code of [
      'insufficient_rest',
      'too_many_consecutive_shifts',
      'too_many_consecutive_nights',
      'missing_required_days_off',
      'works_during_approved_time_off',
      'overlapping_assignments',
      'over_max_hours',
      'unauthorised_overtime',
      'missing_charge_nurse',
      'missing_credential',
      'all_novice_shift',
      'incompatible_staff_unbuffered',
    ]) {
      expect(violations.get(code) ?? 0, code).toBe(0);
    }
    expect(
      f.count(`SELECT COUNT(*) n FROM assignment a JOIN nurse n ON n.id = a.nurse_id
                 WHERE a.date < n.seniority_date`),
    ).toBe(0);
  });

  it('only runs a shift short, or over ratio, when a call-off could not be covered', () => {
    const violations = historyViolations(f);
    const uncovered = f.count("SELECT COUNT(*) n FROM call_off WHERE status = 'uncovered'");
    const uncoveredRn = f.count(
      `SELECT COUNT(*) n FROM call_off c JOIN nurse n ON n.id = c.nurse_id
         WHERE c.status = 'uncovered' AND n.role = 'RN'`,
    );
    expect(violations.get('understaffed') ?? 0).toBeLessThanOrEqual(uncovered);
    expect(violations.get('ratio_breach') ?? 0).toBeLessThanOrEqual(uncoveredRn);
    // About two call-offs a week over six months.
    const callOffs = f.count('SELECT COUNT(*) n FROM call_off');
    expect(callOffs).toBeGreaterThan(35);
    expect(callOffs).toBeLessThan(75);
  });

  it('credits paid leave and sick calls, so a nurse rarely reads short of contract', () => {
    // Uncredited, vacations and sick calls left 8–15% of nurse-pay-periods "under contract".
    const nursePeriods = f.count('SELECT COUNT(*) n FROM nurse') * 13;
    const under = historyViolations(f).get('under_contracted_hours') ?? 0;
    expect(under / nursePeriods).toBeLessThan(0.05);
    expect(
      f.count(
        "SELECT COUNT(*) n FROM time_off_request WHERE status = 'approved' AND paid_hours > 0",
      ),
    ).toBeGreaterThan(20);
    expect(f.count('SELECT COUNT(*) n FROM call_off WHERE paid_sick_hours > 0')).toBeGreaterThan(
      20,
    );
  });

  it('puts one charge nurse on every staffed shift of the history that needs its own', () => {
    const shifts = f.rows<{ charges: number; own: number }>(
      `SELECT SUM(a.is_charge) charges, st.within_shift_type_id IS NULL own FROM assignment a
         JOIN schedule_period p ON p.id = a.period_id JOIN shift_type st ON st.id = a.shift_type_id
         WHERE p.status = 'published' GROUP BY a.date, a.shift_type_id`,
    );
    expect(shifts.filter((s) => s.own === 1).length).toBeGreaterThan(300);
    expect(shifts.filter((s) => s.charges !== (s.own === 1 ? 1 : 0))).toEqual([]);
  });

  it('gives everyone BLS and every charge nurse ACLS, with no card already lapsed', () => {
    expect(
      f.count(`SELECT COUNT(*) n FROM nurse WHERE id NOT IN (SELECT nc.nurse_id
                 FROM nurse_credential nc JOIN credential c ON c.id = nc.credential_id
                 WHERE c.code = 'BLS')`),
    ).toBe(0);
    expect(
      f.count(`SELECT COUNT(*) n FROM nurse WHERE is_charge_eligible = 1 AND id NOT IN (
                 SELECT nc.nurse_id FROM nurse_credential nc JOIN credential c
                 ON c.id = nc.credential_id WHERE c.code = 'ACLS')`),
    ).toBe(0);
    expect(f.count(`SELECT COUNT(*) n FROM nurse_credential WHERE expires_on < '${today}'`)).toBe(
      0,
    );
  });

  it('prices every past shift and keeps spending within a few percent of budget', () => {
    const db = f.handle.db;
    for (const period of listPeriodsForUnit(db, f.result.unitId)) {
      if (period.status !== 'published') continue;
      const input = loadPeriodInput(db, period);
      const cost = costSchedule(
        new ScheduleView({
          period,
          assignments: input.assignments,
          nurses: input.nurses,
          shiftTypes: input.shiftTypes,
        }),
        costContext(db, f.result.unitId, input.ruleSet),
      );
      expect(cost.unpricedAssignments).toBe(0);
      const budget = f.count(
        `SELECT target_dollars n FROM budget WHERE period_id = '${period.id}'`,
      );
      expect(Math.abs(cost.totals.total / budget - 1)).toBeLessThan(0.06);
    }
  });

  it('has requests waiting on the manager for the next schedule', () => {
    expect(
      f.count(
        `SELECT COUNT(*) n FROM time_off_request WHERE status = 'pending'
           AND start_date >= '${f.result.draftStart}'`,
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it(
    'lets Generate fill every floor of the next schedule without breaking a nurse-level rule',
    () => {
      const input = loadPeriodInput(f.handle.db, getPeriod(f.handle.db, f.result.draftPeriodId)!);
      // The app's default budget (`solver-jobs.ts`).
      const report = solve(input, { seed: 1, maxIterations: 200_000 });
      expect(report.unfilled).toEqual([]);
      const nurseLevel = report.hardViolations.filter(
        (v) => v.code !== 'under_contracted_hours' && v.code !== 'over_contracted_hours',
      );
      expect(nurseLevel).toEqual([]);
    },
    slow(60_000),
  );

  it(
    'is the same unit every time for the same seed and date',
    () => {
      const other = openTestDatabase();
      try {
        transact(other.db, (tx) => seedDemoUnit(tx, { demo, today }));
        const projection = (h: OpenedDatabase) =>
          h.sqlite
            .prepare(
              `SELECT n.employee_id, a.date, st.abbreviation, a.is_charge FROM assignment a
               JOIN nurse n ON n.id = a.nurse_id JOIN shift_type st ON st.id = a.shift_type_id
               ORDER BY a.date, st.abbreviation, n.employee_id`,
            )
            .all();
        expect(projection(other)).toEqual(projection(f.handle));
      } finally {
        other.close();
      }
    },
    SEED_TIMEOUT_MS,
  );

  it('writes an audit trail naming the seeder', () => {
    expect(f.count("SELECT COUNT(*) n FROM audit_log WHERE actor != 'demo-seed'")).toBe(0);
    expect(f.count("SELECT COUNT(*) n FROM audit_log WHERE action = 'publish'")).toBe(13);
  });
}
