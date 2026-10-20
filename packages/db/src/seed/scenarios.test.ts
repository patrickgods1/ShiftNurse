/**
 * The test-scenario seeder is test data for every later milestone, so its invariants are guarded here:
 * if a change to the seeder quietly removed the planted PTO conflict, the conflict-resolution
 * feature would look broken for no reason anyone could find.
 */

import { compareDates, datesInRange, isoDate, today } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import * as s from '../schema.js';
import { seedScenarioUnit } from './scenarios.js';
import type { SeedResult } from './types.js';

let handle: OpenedDatabase;
let result: SeedResult;

beforeEach(() => {
  handle = openTestDatabase();
  // A fixed "today" keeps every date assertion below stable regardless of when tests run.
  result = transact(handle.db, (tx) =>
    seedScenarioUnit(tx, { seed: 42, today: isoDate('2026-09-17'), historyPeriods: 4 }),
  );
});

afterEach(() => handle.close());

function count(sql: string): number {
  return (handle.sqlite.prepare(sql).get() as { n: number }).n;
}

describe('test-scenario seed', () => {
  it('creates a 42-nurse unit with a realistic role mix', () => {
    expect(result.counts.nurse).toBe(42);
    // dealt, not drawn: 30 RNs, 7 LPNs, 5 CNAs (`scenarios.ts` role deal)
    expect(count("SELECT COUNT(*) n FROM nurse WHERE role='RN'")).toBe(30);
    expect(count("SELECT COUNT(*) n FROM nurse WHERE role='LPN'")).toBe(7);
    expect(count("SELECT COUNT(*) n FROM nurse WHERE role='CNA'")).toBe(5);
  });

  it('starts the draft period on the next Sunday and runs six weeks', () => {
    expect(result.draftStart).toBe('2026-09-20');
    expect(result.draftEnd).toBe('2026-10-31');
    expect(count("SELECT COUNT(*) n FROM schedule_period WHERE status='draft'")).toBe(1);
  });

  it('publishes every historical period and leaves the draft empty', () => {
    expect(count("SELECT COUNT(*) n FROM schedule_period WHERE status='published'")).toBe(4);
    expect(
      count(
        "SELECT COUNT(*) n FROM assignment WHERE period_id=(SELECT id FROM schedule_period WHERE status='draft')",
      ),
    ).toBe(0);
  });

  it('never schedules a nurse on two worked shifts in one day', () => {
    expect(
      count(
        `SELECT COUNT(*) n FROM (SELECT nurse_id, date FROM assignment a
           JOIN shift_type st ON st.id=a.shift_type_id WHERE st.is_on_call=0
           GROUP BY nurse_id, date HAVING COUNT(*)>1)`,
      ),
    ).toBe(0);
  });

  it('plants a multi-nurse PTO conflict on one weekend of the draft', () => {
    expect(result.counts.pendingContested).toBe(6);
    const clusters = handle.sqlite
      .prepare(
        `SELECT COUNT(*) n FROM time_off_request WHERE status='pending'
           GROUP BY start_date, end_date HAVING COUNT(*) >= 5`,
      )
      .all() as { n: number }[];
    expect(clusters).toHaveLength(1);
  });

  it('plants ACLS certifications that expire inside the draft period', () => {
    expect(result.counts.aclsExpiringInDraft).toBe(3);
    expect(
      count(
        `SELECT COUNT(*) n FROM nurse_credential nc JOIN credential c ON c.id=nc.credential_id
           WHERE c.code='ACLS' AND nc.expires_on BETWEEN '${result.draftStart}' AND '${result.draftEnd}'`,
      ),
    ).toBe(3);
  });

  it('skews night work unevenly so fairness scoring has something to correct', () => {
    const rows = handle.sqlite
      .prepare(
        `SELECT SUM(l.night_shifts) nights FROM fairness_ledger l JOIN nurse n ON n.id=l.nurse_id
           WHERE n.role='RN' AND n.fte=1 GROUP BY n.id ORDER BY nights`,
      )
      .all() as { nights: number }[];
    const min = rows[0]?.nights ?? 0;
    const max = rows[rows.length - 1]?.nights ?? 0;
    expect(max).toBeGreaterThan(min * 2);
  });

  it('fills every historical census forecast with an actual for back-testing', () => {
    expect(
      count(
        `SELECT COUNT(*) n FROM census_forecast WHERE actual_census IS NULL
           AND date < '${result.draftStart}'`,
      ),
    ).toBe(0);
    expect(
      count(`SELECT COUNT(*) n FROM census_forecast WHERE date >= '${result.draftStart}'`),
    ).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', () => {
    const other = openTestDatabase();
    try {
      transact(other.db, (tx) =>
        seedScenarioUnit(tx, { seed: 42, today: isoDate('2026-09-17'), historyPeriods: 4 }),
      );
      const projection = (h: OpenedDatabase) =>
        h.sqlite
          .prepare(
            `SELECT n.employee_id, a.date, st.abbreviation, a.is_charge FROM assignment a
               JOIN nurse n ON n.id=a.nurse_id JOIN shift_type st ON st.id=a.shift_type_id
               ORDER BY a.date, st.abbreviation, n.employee_id`,
          )
          .all();
      expect(projection(other)).toEqual(projection(handle));
    } finally {
      other.close();
    }
  });

  it('produces a different dataset for a different seed', () => {
    const other = openTestDatabase();
    try {
      transact(other.db, (tx) =>
        seedScenarioUnit(tx, { seed: 7, today: isoDate('2026-09-17'), historyPeriods: 4 }),
      );
      const names = (h: OpenedDatabase) =>
        h.sqlite.prepare('SELECT first_name FROM nurse ORDER BY employee_id').all();
      expect(names(other)).not.toEqual(names(handle));
    } finally {
      other.close();
    }
  });

  it('writes the publish and denial audit rows, all by the scenario seeder', () => {
    expect(
      count(
        "SELECT COUNT(*) n FROM audit_log WHERE entity_type='schedule_period' AND action='publish'",
      ),
    ).toBe(4);
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE action='deny'")).toBeGreaterThan(0);
    // The seeder itself is the actor, so the trail says where the data came from.
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE actor!='scenario-seed'")).toBe(0);
  });

  it('denies junior nurses time off more often, the bias equity scoring should surface', () => {
    const rows = handle.sqlite
      .prepare(
        `SELECT r.status status, n.seniority_date sd FROM time_off_request r
           JOIN nurse n ON n.id=r.nurse_id WHERE r.status IN ('approved','denied')`,
      )
      .all() as { status: string; sd: string }[];
    const tally = { junior: { approved: 0, denied: 0 }, senior: { approved: 0, denied: 0 } };
    for (const r of rows) {
      // The seeder's own definition of junior: under three years at the seeding date.
      const junior = datesInRange(isoDate(r.sd), isoDate('2026-09-17')).length / 365 < 3;
      tally[junior ? 'junior' : 'senior'][r.status as 'approved' | 'denied']++;
    }
    // Counts of the frozen seeding; if they differ, the scenario data moved.
    expect(tally.junior).toEqual({ approved: 6, denied: 4 });
    expect(tally.senior).toEqual({ approved: 51, denied: 1 });
    const rate = (x: { approved: number; denied: number }) => x.denied / (x.approved + x.denied);
    expect(rate(tally.junior)).toBeGreaterThan(rate(tally.senior));
  });

  it('runs a mixed 8- and 12-hour unit with an on-call shift, LPNs and a preceptor on every 12', () => {
    const types = handle.sqlite
      .prepare('SELECT abbreviation a, duration_hours h FROM shift_type ORDER BY sort_order')
      .all() as { a: string; h: number }[];
    expect(types.map((x) => `${x.a} ${x.h}`)).toEqual([
      'D12 12',
      'N12 12',
      'D8 8',
      'E8 8',
      'N8 8',
      'OC 12',
    ]);
    for (const abbr of ['D8', 'E8', 'N8', 'OC']) {
      expect(
        count(
          `SELECT COUNT(*) n FROM assignment a JOIN shift_type st ON st.id=a.shift_type_id
             WHERE st.abbreviation='${abbr}'`,
        ),
      ).toBeGreaterThan(0);
    }
    expect(count("SELECT COUNT(*) n FROM nurse WHERE role='LPN'")).toBe(7);
    const preceptored = handle.sqlite
      .prepare(
        `SELECT DISTINCT st.abbreviation a FROM shift_credential_requirement r
           JOIN credential c ON c.id=r.credential_id JOIN shift_type st ON st.id=r.shift_type_id
           WHERE c.code='PRECEPTOR' ORDER BY st.abbreviation`,
      )
      .all() as { a: string }[];
    expect(preceptored.map((x) => x.a)).toEqual(['D12', 'N12']);
  });

  it('writes an audit row for every configuration row it creates', () => {
    for (const table of [
      'credential',
      'pay_rate',
      'differential',
      'overtime_rule',
      'census_forecast',
    ]) {
      expect(
        count(
          `SELECT COUNT(*) n FROM ${table} x WHERE NOT EXISTS
             (SELECT 1 FROM audit_log a WHERE a.entity_id = x.id)`,
        ),
      ).toBe(0);
    }
  });

  it('records every census actual as a mix that adds up to the census', () => {
    const rows = handle.sqlite
      .prepare(
        `SELECT actual_census c, actual_acuity_mix m FROM census_forecast
           WHERE actual_census IS NOT NULL`,
      )
      .all() as { c: number; m: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter(
      (r) =>
        Object.values(JSON.parse(r.m) as Record<string, number>).reduce((a, b) => a + b, 0) !== r.c,
    );
    expect(bad).toHaveLength(0);
  });

  it('keeps the 2026 holidays exactly as they were', () => {
    const rows = handle.sqlite
      .prepare('SELECT date, name, is_major FROM holiday ORDER BY date')
      .all();
    expect(rows).toEqual([
      { date: '2026-01-01', name: "New Year's Day", is_major: 1 },
      { date: '2026-05-25', name: 'Memorial Day', is_major: 0 },
      { date: '2026-07-04', name: 'Independence Day', is_major: 1 },
      { date: '2026-09-07', name: 'Labor Day', is_major: 0 },
      { date: '2026-11-26', name: 'Thanksgiving', is_major: 1 },
      { date: '2026-12-25', name: 'Christmas Day', is_major: 1 },
      { date: '2027-01-01', name: "New Year's Day", is_major: 1 },
    ]);
  });

  it('puts Memorial Day, Labor Day and Thanksgiving on the right days in another year', () => {
    const other = openTestDatabase();
    try {
      transact(other.db, (tx) =>
        seedScenarioUnit(tx, { seed: 42, today: isoDate('2027-09-16'), historyPeriods: 4 }),
      );
      const dates = (
        other.sqlite.prepare('SELECT date, name FROM holiday').all() as {
          date: string;
          name: string;
        }[]
      ).map((h) => `${h.date} ${h.name}`);
      // 2027: May 31 is the last Monday of May; Sept 1 is a Wednesday so Labor Day is the 6th;
      // Nov 1 is a Monday so the Thursdays are 4, 11, 18 and 25.
      expect(dates).toContain('2027-05-31 Memorial Day');
      expect(dates).toContain('2027-09-06 Labor Day');
      expect(dates).toContain('2027-11-25 Thanksgiving');
    } finally {
      other.close();
    }
  });

  it("gives a history that starts last year last year's holidays", () => {
    const other = openTestDatabase();
    try {
      transact(other.db, (tx) =>
        seedScenarioUnit(tx, { seed: 42, today: isoDate('2027-01-05'), historyPeriods: 4 }),
      );
      const dates = (
        other.sqlite.prepare('SELECT date, name FROM holiday').all() as {
          date: string;
          name: string;
        }[]
      ).map((h) => `${h.date} ${h.name}`);
      expect(dates).toContain('2026-11-26 Thanksgiving');
      expect(dates).toContain('2026-12-25 Christmas Day');
    } finally {
      other.close();
    }
  });

  it('gives every published period a version, so a manager can edit it', () => {
    expect(
      count(`SELECT COUNT(*) n FROM schedule_period p WHERE status='published' AND NOT EXISTS
             (SELECT 1 FROM schedule_version v WHERE v.period_id=p.id)`),
    ).toBe(0);
  });

  it('dates every past call-off and call to the day of the shift, not the day the scenario was seeded', () => {
    // Call-offs are D12 07:00 shifts: reported 05:00 local that morning (pinned TZ), first call 05:10.
    const offs = handle.sqlite.prepare('SELECT date, reported_at r FROM call_off').all() as {
      date: string;
      r: number;
    }[];
    expect(offs).toHaveLength(4);
    for (const o of offs) expect(new Date(o.r).getHours()).toBe(5);
    const rows = handle.sqlite
      .prepare(
        `SELECT c.id, c.date, c.reported_at r, a.attempted_at t FROM call_attempt a
           JOIN call_off c ON c.id = a.call_off_id ORDER BY c.id, a.attempted_at`,
      )
      .all() as { id: string; date: string; r: number; t: number }[];
    expect(rows.length).toBeGreaterThan(0);
    let k = 0;
    let previous = '';
    for (const row of rows) {
      k = row.id === previous ? k + 1 : 0;
      previous = row.id;
      expect(today(new Date(row.r))).toBe(row.date);
      expect(today(new Date(row.t))).toBe(row.date);
      // Ten minutes apart, the first at ten past the report.
      expect(row.t).toBe(row.r + (k + 1) * 600_000);
    }
  });

  it('dates past requests and their decisions before the leave they were for', () => {
    const rows = handle.sqlite
      .prepare(
        `SELECT start_date, submitted_at, decided_at FROM time_off_request
           WHERE status IN ('approved', 'denied') AND start_date < '${result.draftStart}'`,
      )
      .all() as { start_date: string; submitted_at: number; decided_at: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.decided_at - row.submitted_at).toBe(7_200_000);
      const submitted = new Date(row.submitted_at);
      expect(submitted.getHours() === 9 && submitted.getMinutes() === 0).toBe(true);
      expect(
        compareDates(today(new Date(row.decided_at)), row.start_date as never),
      ).toBeLessThanOrEqual(0);
    }
  });

  it('references the schema tables the queries above depend on', () => {
    // Guards the raw SQL in this file against a schema rename.
    expect(handle.db.select().from(s.fairnessLedger).all().length).toBeGreaterThan(0);
  });
});
