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

/** The migrations folder as an older release shipped it: every migration but the last `drop`. */
function olderRelease(drop: number): string {
  const folder = join(dir, 'older');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, journal.entries.length - drop);
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
