/**
 * The demo seeder is test data for every later milestone, so its invariants are guarded here:
 * if a change to the seeder quietly removed the planted PTO conflict, the conflict-resolution
 * feature would look broken for no reason anyone could find.
 */

import { isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import * as s from '../schema.js';
import { type SeedResult, seedDemoUnit } from './demo.js';

let handle: OpenedDatabase;
let result: SeedResult;

beforeEach(() => {
  handle = openTestDatabase();
  // A fixed "today" keeps every date assertion below stable regardless of when tests run.
  result = transact(handle.db, (tx) =>
    seedDemoUnit(tx, { seed: 42, today: isoDate('2026-09-17'), historyPeriods: 4 }),
  );
});

afterEach(() => handle.close());

function count(sql: string): number {
  return (handle.sqlite.prepare(sql).get() as { n: number }).n;
}

describe('demo seed', () => {
  it('creates a 42-nurse unit with a realistic role mix', () => {
    expect(result.counts.nurse).toBe(42);
    const rns = count("SELECT COUNT(*) n FROM nurse WHERE role='RN'");
    // Weighted 60/25/15, so RNs should be a clear majority without being everyone.
    expect(rns).toBeGreaterThan(18);
    expect(rns).toBeLessThan(36);
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
        seedDemoUnit(tx, { seed: 42, today: isoDate('2026-09-17'), historyPeriods: 4 }),
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
        seedDemoUnit(tx, { seed: 7, today: isoDate('2026-09-17'), historyPeriods: 4 }),
      );
      const names = (h: OpenedDatabase) =>
        h.sqlite.prepare('SELECT first_name FROM nurse ORDER BY employee_id').all();
      expect(names(other)).not.toEqual(names(handle));
    } finally {
      other.close();
    }
  });

  it('writes an audit trail for the whole seed', () => {
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE action='publish'")).toBe(4);
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE action='deny'")).toBeGreaterThan(0);
    // The seeder itself is the actor, so the trail says where the data came from.
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE actor!='demo-seed'")).toBe(0);
  });

  it('references the schema tables the queries above depend on', () => {
    // Guards the raw SQL in this file against a schema rename.
    expect(handle.db.select().from(s.fairnessLedger).all().length).toBeGreaterThan(0);
  });
});
