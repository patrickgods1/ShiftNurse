/**
 * The checks every realistic demo must pass, shared by the per-unit test files. A demo is what
 * an evaluator judges the product by: a history that shows someone working the morning after a
 * night, or a next schedule Generate cannot fill, makes the app look broken when the data is to
 * blame. Each unit's own test file adds the facts that make that unit what it is.
 */

import {
  buildRuleContext,
  compareDates,
  costSchedule,
  datesInRange,
  today as dayOf,
  deriveDemand,
  evaluateSchedule,
  type IsoDate,
  ScheduleView,
  solve,
  type Violation,
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
import { PRIOR_ASSIGNMENT_LOOKBACK_DAYS } from '../../repositories/period-window.js';
import { listPreceptorships } from '../../repositories/preceptorships.js';
import {
  listCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listPreferencesForUnit,
} from '../../repositories/roster.js';
import { getRuleSet } from '../../repositories/rulesets.js';
import {
  getPeriod,
  listAssignmentsForPeriod,
  listPeriodsForUnit,
  priorAssignmentsBefore,
} from '../../repositories/schedule.js';
import {
  costContext,
  demandInputs,
  historyFromFor,
  loadPeriodInput,
} from '../../repositories/solve-input.js';
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
  const byCode = new Map<string, number>();
  for (const v of historyViolationList(f, severity))
    byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);
  return byCode;
}

/** The violations themselves, for a check that needs to know whom or when they name. */
export function historyViolationList(f: DemoFixture, severity: 'hard' | 'soft' = 'hard') {
  const db = f.handle.db;
  const unit = getUnit(db, f.result.unitId)!;
  const nurses = listNursesForUnit(db, unit.id);
  const shiftTypes = listShiftTypesForUnit(db, unit.id);
  const all: Violation[] = [];
  for (const period of listPeriodsForUnit(db, unit.id)) {
    if (period.status !== 'published') continue;
    const ruleSet = getRuleSet(db, period.ruleSetId)!;
    // With the tail the app judges a period with: a rolling four-weekend window reaches back
    // past a 14-day period's first weekend, so without it the weekends before go unseen.
    const view = new ScheduleView({
      period,
      assignments: listAssignmentsForPeriod(db, period.id),
      priorAssignments: priorAssignmentsBefore(
        db,
        unit.id,
        period.startDate,
        PRIOR_ASSIGNMENT_LOOKBACK_DAYS,
      ),
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
      historyFrom: historyFromFor(db, period),
      preferences: listPreferencesForUnit(db, unit.id),
    });
    const result = evaluateSchedule(view, ruleSet, ctx);
    all.push(...(severity === 'hard' ? result.hardViolations : result.softViolations));
  }
  return all;
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
      'multiple_charge_nurses',
      'missing_credential',
      'all_novice_shift',
      'incompatible_staff_unbuffered',
    ]) {
      expect(violations.get(code) ?? 0, code).toBe(0);
    }
    // Cannot go red with today's data (no bridge falls inside the history); guards a future one.
    expect(
      f.count(`SELECT COUNT(*) n FROM assignment a JOIN nurse n ON n.id = a.nurse_id
                 WHERE a.date < COALESCE(n.hire_date, n.seniority_date)`),
    ).toBe(0);
  });

  it('never approves two requests for the same nurse on the same day', () => {
    // Two date ranges overlap when each starts on or before the other ends.
    expect(
      f.count(`SELECT COUNT(*) n FROM time_off_request a JOIN time_off_request b
                 ON a.nurse_id = b.nurse_id AND a.id < b.id
                 WHERE a.status = 'approved' AND b.status = 'approved'
                   AND a.start_date <= b.end_date AND b.start_date <= a.end_date`),
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

  it('never phones a nurse back onto a shift the same day she called off', () => {
    // A manager would not call back someone who just called in sick; the sick credit and the
    // replacement tour would also double-count her hours.
    expect(
      f.count(`SELECT COUNT(*) n FROM call_off c JOIN assignment a
                 ON a.nurse_id = c.nurse_id AND a.date = c.date AND a.source = 'callout'`),
    ).toBe(0);
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

  it('dates every past call-off and call to the day of the shift, not the day the demo was seeded', () => {
    // A D12 07:00 call-off is reported at 05:00 that morning and the first call is at 05:10.
    const rows = f.rows<{ id: string; date: IsoDate; r: number; t: number }>(
      `SELECT c.id, c.date, c.reported_at r, a.attempted_at t FROM call_attempt a
         JOIN call_off c ON c.id = a.call_off_id ORDER BY c.id, a.attempted_at`,
    );
    expect(rows.length).toBeGreaterThan(35);
    let k = 0;
    let previous = '';
    for (const row of rows) {
      k = row.id === previous ? k + 1 : 0;
      previous = row.id;
      expect(dayOf(new Date(row.r))).toBe(row.date);
      expect(dayOf(new Date(row.t))).toBe(row.date);
      // Ten minutes apart, the first at ten past the report.
      expect(row.t).toBe(row.r + (k + 1) * 600_000);
    }
  });

  it('dates past requests and their decisions before the leave they were for', () => {
    // Submitted four weeks ahead and decided two hours later, the same morning.
    const rows = f.rows<{ start_date: IsoDate; submitted_at: number; decided_at: number }>(
      `SELECT start_date, submitted_at, decided_at FROM time_off_request
         WHERE status IN ('approved', 'denied') AND start_date < '${f.result.draftStart}'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.decided_at - row.submitted_at).toBe(7_200_000);
      const submitted = new Date(row.submitted_at);
      expect(submitted.getHours() === 9 && submitted.getMinutes() === 0).toBe(true);
      expect(compareDates(dayOf(new Date(row.decided_at)), row.start_date)).toBeLessThanOrEqual(0);
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
    expect(
      f.count(
        "SELECT COUNT(*) n FROM audit_log WHERE entity_type = 'schedule_period' AND action = 'publish'",
      ),
    ).toBe(13);
    // The ledger is booked at publish, as the app books it, not imported after the fact.
    expect(
      f.count(
        "SELECT COUNT(*) n FROM audit_log WHERE entity_type = 'fairness_ledger' AND action = 'import'",
      ),
    ).toBe(0);
  });

  it('books a ledger row for each nurse who worked a published period and a zero one for each active home nurse who was there and did not', () => {
    const booked = f.count(`SELECT COUNT(*) n FROM fairness_ledger l
      JOIN schedule_period p ON p.id = l.period_id WHERE p.status = 'published'`);
    const worked = f.count(`SELECT COUNT(*) n FROM (SELECT DISTINCT a.nurse_id, a.period_id
      FROM assignment a JOIN schedule_period p ON p.id = a.period_id WHERE p.status = 'published')`);
    // Derived from the roster, not from the ledger: active nurses of the period's unit with no
    // shift in it, hired by its last day and not on approved leave for the whole period.
    // (No demo deactivates a nurse after publishing, so today's flag is the flag at publish.)
    const shiftlessAndThere = f.count(`SELECT COUNT(*) n FROM schedule_period p
      JOIN nurse n ON n.unit_id = p.unit_id AND n.active = 1
      WHERE p.status = 'published'
        AND (n.hire_date IS NULL OR n.hire_date <= p.end_date)
        AND NOT EXISTS (SELECT 1 FROM assignment a
          WHERE a.nurse_id = n.id AND a.period_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM time_off_request t
          WHERE t.nurse_id = n.id AND t.status = 'approved'
            AND t.start_date <= p.start_date AND t.end_date >= p.end_date)`);
    expect(shiftlessAndThere).toBeGreaterThan(0);
    expect(booked).toBe(worked + shiftlessAndThere);
    const burdenWithoutShifts = f.count(`SELECT COUNT(*) n FROM fairness_ledger l
      JOIN schedule_period p ON p.id = l.period_id
      WHERE p.status = 'published'
        AND NOT EXISTS (SELECT 1 FROM assignment a
          WHERE a.nurse_id = l.nurse_id AND a.period_id = l.period_id)
        AND (l.total_hours <> 0 OR l.night_shifts <> 0 OR l.weekends_worked <> 0
          OR l.holidays_worked <> 0)`);
    expect(burdenWithoutShifts).toBe(0);
  });

  it('counts denials and covered call-outs in the ledger, as the app does', () => {
    const published = "JOIN schedule_period p ON p.id = l.period_id WHERE p.status = 'published'";
    // A denial counts in the period its leave starts in, for a nurse with a row there.
    const denials = f.count(`SELECT COUNT(*) n FROM time_off_request r JOIN schedule_period p
        ON r.start_date BETWEEN p.start_date AND p.end_date AND p.status = 'published'
        AND p.unit_id = '${f.result.unitId}'
      WHERE r.status = 'denied' AND EXISTS (SELECT 1 FROM assignment a
        WHERE a.nurse_id = r.nurse_id AND a.period_id = p.id)`);
    expect(denials).toBeGreaterThan(0);
    expect(
      f.count(`SELECT COALESCE(SUM(l.requests_denied), 0) n FROM fairness_ledger l ${published}`),
    ).toBe(denials);
    // A covered call-out is a shift that came in by phone.
    const covers = f.count(`SELECT COUNT(*) n FROM assignment a JOIN schedule_period p
      ON p.id = a.period_id WHERE p.status = 'published' AND a.source = 'callout'`);
    expect(covers).toBeGreaterThan(20);
    expect(
      f.count(`SELECT COALESCE(SUM(l.call_outs_covered), 0) n FROM fairness_ledger l ${published}`),
    ).toBe(covers);
  });

  it('charges no overtime to per-diem staff, who have no contract to be over', () => {
    expect(
      f.count(`SELECT COALESCE(SUM(l.overtime_hours), 0) n FROM fairness_ledger l
        JOIN nurse n ON n.id = l.nurse_id WHERE n.contracted_hours_per_period = 0`),
    ).toBe(0);
  });

  it('gives every published period a version, so a manager can edit it', () => {
    expect(
      f.count(`SELECT COUNT(*) n FROM schedule_period p WHERE status = 'published' AND NOT EXISTS
               (SELECT 1 FROM schedule_version v WHERE v.period_id = p.id)`),
    ).toBe(0);
  });
}
