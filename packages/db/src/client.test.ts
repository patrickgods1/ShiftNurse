/**
 * Opening a database the app did not just create: an upgrade with migrations still to run, and
 * a file written by a newer version of the app. Both happen on a real install — the first on
 * every release with a schema change, the second when a manager restores a backup taken after
 * an update onto a machine still on the old version.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DatabaseNewerThanAppError,
  migrateDatabase,
  migrationStatus,
  migrationsFolder,
  openDatabase,
} from './client.js';
import { getHomeUnit } from './repositories/config.js';

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

const FULL = migrationsFolder();
const journal = JSON.parse(readFileSync(join(FULL, 'meta', '_journal.json'), 'utf8')) as Journal;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiftnurse-migrations-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The migrations folder as an older release shipped it: every migration but the last `drop`, or
 * every one before the migration tagged `drop`.
 */
function olderRelease(drop: number | string): string {
  const folder = join(dir, 'older');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const cut =
    typeof drop === 'number'
      ? journal.entries.length - drop
      : journal.entries.findIndex((e) => e.tag === drop);
  if (cut < 0) throw new Error(`No migration tagged ${drop}`);
  const entries = journal.entries.slice(0, cut);
  for (const e of entries) copyFileSync(join(FULL, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

describe('opening a database across app versions', () => {
  it('sees a brand-new file as fresh, with every migration still to run', () => {
    const opened = openDatabase({ url: ':memory:', migrateOnOpen: false });
    expect(migrationStatus(opened.sqlite, FULL)).toEqual({
      fresh: true,
      pending: journal.entries.length,
      newerThanApp: false,
    });
    opened.close();
  });

  it('finds nothing to do once the database is up to date', () => {
    const opened = openDatabase({ url: ':memory:' });
    expect(migrationStatus(opened.sqlite, FULL)).toEqual({
      fresh: false,
      pending: 0,
      newerThanApp: false,
    });
    opened.close();
  });

  it('counts the two migrations an update brings to a database from the release before', () => {
    const url = join(dir, 'live.sqlite');
    openDatabase({ url, migrationsFolder: olderRelease(2) }).close();

    const opened = openDatabase({ url, migrateOnOpen: false });
    expect(migrationStatus(opened.sqlite, FULL)).toEqual({
      fresh: false,
      pending: 2,
      newerThanApp: false,
    });
    migrateDatabase(opened.db, FULL);
    expect(migrationStatus(opened.sqlite, FULL).pending).toBe(0);
    opened.close();
  });

  it('refuses a database from a newer release rather than running old code against it', () => {
    const url = join(dir, 'live.sqlite');
    openDatabase({ url }).close();

    const older = olderRelease(1);
    const opened = openDatabase({ url, migrateOnOpen: false });
    expect(migrationStatus(opened.sqlite, older).newerThanApp).toBe(true);
    expect(() => migrateDatabase(opened.db, older)).toThrow(DatabaseNewerThanAppError);
    opened.close();

    expect(() => openDatabase({ url, migrationsFolder: older })).toThrow(
      /newer version of ShiftNurse/,
    );
  });
});

describe('upgrading saved data', () => {
  it('adds the float tier after agency to a saved cancellation order', () => {
    const url = join(dir, 'live.sqlite');
    const before = openDatabase({
      url,
      migrationsFolder: olderRelease('0038_float_cancellation_tier'),
    });
    const saved = [
      '["volunteer","agency","overtime","per_diem","rotation"]',
      '["volunteer","rotation"]',
      '["rotation"]',
    ];
    for (const [i, tiers] of saved.entries()) {
      before.sqlite
        .prepare(
          "insert into unit (id, name, unit_type, pay_period_days, pay_period_anchor) values (?, ?, 'Medical-Surgical', 14, '2026-01-04')",
        )
        .run(`u${i}`, `Unit ${i}`);
      before.sqlite
        .prepare('insert into cancellation_policy (id, unit_id, tiers) values (?, ?, ?)')
        .run(`p${i}`, `u${i}`, tiers);
    }
    before.close();

    const opened = openDatabase({ url, migrationsFolder: FULL });
    const read = () =>
      (
        opened.sqlite.prepare('select tiers from cancellation_policy order by id').all() as {
          tiers: string;
        }[]
      ).map((r) => r.tiers);
    const upgraded = [
      '["volunteer","agency","float","overtime","per_diem","rotation"]',
      '["volunteer","float","rotation"]',
      '["float","rotation"]',
    ];
    expect(read()).toEqual(upgraded);

    // Running the upgrade again leaves an order that already has the float tier alone.
    const sql = readFileSync(join(FULL, '0038_float_cancellation_tier.sql'), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) opened.sqlite.exec(statement);
    expect(read()).toEqual(upgraded);
    opened.close();
  });

  it('an install from before this release marks its first unit as home', () => {
    const url = join(dir, 'live.sqlite');
    const before = openDatabase({ url, migrationsFolder: olderRelease('0040_home_unit') });
    // Zeta goes in first, so it has rowid 1 even though Alpha sorts ahead of it by name.
    for (const [id, name] of [
      ['u-zeta', 'Zeta'],
      ['u-alpha', 'Alpha'],
    ] as const) {
      before.sqlite
        .prepare(
          "insert into unit (id, name, unit_type, pay_period_days, pay_period_anchor) values (?, ?, 'Medical-Surgical', 14, '2026-01-04')",
        )
        .run(id, name);
    }
    before.close();

    const opened = openDatabase({ url, migrationsFolder: FULL });
    expect(getHomeUnit(opened.db)?.name).toBe('Zeta');
    opened.close();
  });
});
