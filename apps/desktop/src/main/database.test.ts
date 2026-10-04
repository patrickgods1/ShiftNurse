/**
 * Opening the app's database: the paths where data is at risk. A file from an update must be
 * copied before it is migrated, a file from a newer release must be left alone, and a restore
 * is audited exactly once in the database it restored. Electron's `app` is the only thing
 * mocked — it supplies the folder — so the real migrator and real files do the rest.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseNewerThanAppError, openDatabase, recentAudit } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => dirs.userData, getVersion: () => '0.0.0-test', isPackaged: false },
}));

import { writeRestoreMarker } from './backup-files.js';
import {
  closeAppDatabase,
  databasePath,
  getDb,
  openAppDatabase,
  resolveMigrationsFolder,
} from './database.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shiftnurse-db-'));
  dirs.userData = root;
});

afterEach(() => {
  closeAppDatabase();
  rmSync(root, { recursive: true, force: true });
});

/** A file already migrated by this build. */
function migratedFile(): void {
  const handle = openDatabase({ url: databasePath(), migrationsFolder: resolveMigrationsFolder() });
  handle.close();
}

/** A file one release behind: migrated from a copy of the migrations minus the newest. */
function olderFile(): void {
  const folder = join(root, 'older-migrations');
  cpSync(resolveMigrationsFolder(), folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries.pop();
  writeFileSync(journalPath, JSON.stringify(journal));
  openDatabase({ url: databasePath(), migrationsFolder: folder }).close();
}

describe('opening the application database', () => {
  it('migrates a fresh file without taking a pre-migrate backup', async () => {
    const before = vi.fn(async () => {});
    // A brand-new file is "pending" for every migration, so the hook is told it is fresh.
    await openAppDatabase(before);
    expect(before).toHaveBeenCalledTimes(1);
    const [, status] = before.mock.calls[0] as unknown as [unknown, { fresh: boolean }];
    expect(status.fresh).toBe(true);
    expect(recentAudit(getDb(), 5)).toEqual([]);
  });

  it('does not call the hook when the file is already current', async () => {
    migratedFile();
    const before = vi.fn(async () => {});
    await openAppDatabase(before);
    expect(before).not.toHaveBeenCalled();
  });

  it('lets the host copy a file with pending migrations before migrating it', async () => {
    olderFile();
    const applied = (sqlite: { prepare: (q: string) => { get: () => unknown } }) =>
      (sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
    let pendingSeen = -1;
    let appliedInHook = -1;
    const db = await openAppDatabase(async (sqlite, status) => {
      pendingSeen = status.pending;
      // The hook is the host's last chance to copy the file: nothing is migrated yet.
      appliedInHook = applied(sqlite);
    });
    expect(pendingSeen).toBe(1);
    expect(applied(db.$client)).toBe(appliedInHook + 1);
  });

  it('refuses a database a newer release has migrated, and leaves it alone', async () => {
    migratedFile();
    const raw = openDatabase({ url: databasePath(), migrateOnOpen: false });
    raw.sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('from-the-future', 99_999_999_999_999);
    raw.close();

    const before = vi.fn(async () => {});
    await expect(openAppDatabase(before)).rejects.toBeInstanceOf(DatabaseNewerThanAppError);
    expect(before).not.toHaveBeenCalled();
    expect(() => getDb()).toThrow(/not opened/);
  });

  it('audits a pending restore once in the opened database and removes the marker', async () => {
    mkdirSync(root, { recursive: true });
    writeRestoreMarker(root, {
      fileName: 'backup-1.sqlite',
      restoredFrom: 'manual',
      savedAs: 'pre-restore.sqlite',
      at: 1_700_000_000_000,
    });
    await openAppDatabase(async () => {});

    const restores = recentAudit(getDb(), 10).filter((a) => a.action === 'restore');
    expect(restores).toHaveLength(1);
    expect(restores[0]!.entityId).toBe('backup-1.sqlite');
    expect(existsSync(join(root, 'restore-pending.json'))).toBe(false);
  });

  it('ignores a malformed restore marker and still opens', async () => {
    writeFileSync(join(root, 'restore-pending.json'), '{ not json');
    await openAppDatabase(async () => {});
    expect(recentAudit(getDb(), 10).filter((a) => a.action === 'restore')).toHaveLength(0);
  });

  it('returns the same connection when opened twice', async () => {
    const first = await openAppDatabase(async () => {});
    expect(await openAppDatabase(async () => {})).toBe(first);
  });
});
