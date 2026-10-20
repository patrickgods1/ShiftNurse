/**
 * Backups, restore and start over against a real database in a temp `userData`. Restore is the
 * one action that closes the app's only connection, so the paths that matter are the failures:
 * a backup that cannot be copied in must leave the app running, and anything that goes wrong
 * once the connection is closed must still relaunch onto the old file rather than strand the
 * manager on "Database not opened". Electron is mocked for the folder and the relaunch only.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoDate } from '@shiftnurse/core';
import type { MigrationStatus, ShiftNurseDb } from '@shiftnurse/db';
import {
  createUnit,
  listUnits,
  openDatabase,
  recentAudit,
  transact,
  updateUnit,
} from '@shiftnurse/db';
import BetterSqlite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupFileName, readRestoreMarker } from './backup-files.js';

const dirs = vi.hoisted(() => ({ userData: '' }));
const electron = vi.hoisted(() => ({
  relaunch: vi.fn(),
  exit: vi.fn(),
  showErrorBox: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => dirs.userData,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    relaunch: electron.relaunch,
    exit: electron.exit,
  },
  dialog: { showErrorBox: electron.showErrorBox },
}));

type Backups = typeof import('./backups.js');
type Database = typeof import('./database.js');

const DAY = 86_400_000;
/** The relaunch waits 250 ms for the IPC reply; this is that plus a margin. */
const afterRelaunchDelay = () => new Promise((r) => setTimeout(r, 300));
const CANNOT_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;

let root: string;
let backups: Backups;
let database: Database;
let db: ShiftNurseDb;
let unitId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'shiftnurse-backups-'));
  dirs.userData = root;
  // A fresh module per test: the one-restore-at-a-time latch is module state, and a test that
  // relaunched leaves it set, exactly as the real app does.
  vi.resetModules();
  database = await import('./database.js');
  backups = await import('./backups.js');
  db = await database.openAppDatabase(async () => {});
  unitId = transact(db, (tx) =>
    createUnit(
      tx,
      {
        name: '4 North',
        unitType: 'MedSurg',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      'manager',
    ),
  ).id;
});

afterEach(async () => {
  chmodSync(root, 0o755);
  await backups.backupsInFlight();
  database.closeAppDatabase();
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function renameUnit(name: string): void {
  transact(db, (tx) => updateUnit(tx, unitId, { name }, 'manager'));
}

/** The unit's name as the file on disk has it, read through a connection of its own. */
function unitNameOnDisk(): string | undefined {
  const handle = openDatabase({ url: database.databasePath(), migrateOnOpen: false });
  try {
    return listUnits(handle.db)[0]?.name;
  } finally {
    handle.close();
  }
}

function backupNames(): string[] {
  return readdirSync(join(root, 'backups'));
}

describe('taking a backup', () => {
  it('writes a backup under a temporary name and lists it only once it checks out', async () => {
    const before = recentAudit(db, 50).filter((a) => a.action === 'backup').length;
    await backups.createBackup(db, 'manual', 'before-change');

    const names = backupNames();
    expect(names.filter((n) => /^manual-before-change-\d{13}\.sqlite$/.test(n))).toHaveLength(1);
    expect(names.filter((n) => n.endsWith('.partial'))).toEqual([]);
    const rows = recentAudit(db, 50).filter((a) => a.action === 'backup');
    expect(rows).toHaveLength(before + 1);
    const after = rows[0]!.after as { kind: string; bytes: number };
    expect(after.kind).toBe('manual');
    expect(after.bytes).toBeGreaterThan(0);
  });

  it('leaves only finished backups in the folder, with no journal files beside them', async () => {
    await backups.createBackup(db, 'manual', 'before-change');
    await backups.ensureDailyBackup(db);

    const names = backupNames();
    expect(names.filter((n) => /-wal$|-shm$|\.partial/.test(n))).toEqual([]);
    expect(names).toHaveLength(2);
  });

  it('takes no copy before migrating a brand-new or already-current file', async () => {
    const sqlite = database.getSqlite();
    expect(
      await backups.backupBeforeMigrate(sqlite, { fresh: true, pending: 5 } as MigrationStatus),
    ).toBeUndefined();
    expect(
      await backups.backupBeforeMigrate(sqlite, { fresh: false, pending: 0 } as MigrationStatus),
    ).toBeUndefined();
    const taken = await backups.backupBeforeMigrate(sqlite, {
      fresh: false,
      pending: 1,
    } as MigrationStatus);
    expect(taken?.fileName).toMatch(/^pre-migrate-before-v0_0_0-test-\d{13}\.sqlite$/);
    expect(existsSync(taken!.path)).toBe(true);
  });
});

describe('restoring a backup', () => {
  it('refuses a damaged backup without taking a safety copy or stopping anything', async () => {
    mkdirSync(join(root, 'backups'), { recursive: true });
    writeFileSync(join(root, 'backups', 'manual-junk-1700000000000.sqlite'), 'not a database');
    const stopWork = vi.fn();

    await expect(
      backups.restoreBackup(db, 'manual-junk-1700000000000.sqlite', stopWork),
    ).rejects.toThrow('This backup file is damaged and cannot be restored. Choose another backup.');

    expect(backupNames().filter((n) => n.startsWith('pre-restore-'))).toEqual([]);
    expect(stopWork).not.toHaveBeenCalled();
    expect(() => database.getDb()).not.toThrow();
    await afterRelaunchDelay();
    expect(electron.relaunch).not.toHaveBeenCalled();
  });

  it('restores a backup: stops solving, swaps the file and relaunches into it', async () => {
    const b = await backups.createBackup(db, 'manual', 'before-change');
    renameUnit('4 North Renamed');
    const stopWork = vi.fn();

    const safety = await backups.restoreBackup(db, b.fileName, stopWork);

    expect(stopWork).toHaveBeenCalledTimes(1);
    await afterRelaunchDelay();
    expect(electron.relaunch).toHaveBeenCalledTimes(1);
    expect(electron.exit).toHaveBeenCalledTimes(1);
    expect(electron.exit).toHaveBeenCalledWith(0);
    expect(electron.showErrorBox).not.toHaveBeenCalled();
    expect(unitNameOnDisk()).toBe('4 North');
    expect(readRestoreMarker(root)?.fileName).toBe(b.fileName);
    expect(existsSync(join(root, 'shiftnurse.sqlite.restoring'))).toBe(false);
    expect(safety.kind).toBe('pre-restore');
  });

  it('keeps the app running when the backup cannot be copied in', async () => {
    const b = await backups.createBackup(db, 'manual', 'before-change');
    // A directory where the staged copy goes: copying onto it fails before anything is closed.
    mkdirSync(`${database.databasePath()}.restoring`);
    const stopWork = vi.fn();

    const restore = backups.restoreBackup(db, b.fileName, stopWork);
    await expect(restore).rejects.toThrow(
      /^The backup could not be copied into place, so nothing was restored\./,
    );

    expect(stopWork).not.toHaveBeenCalled();
    expect(() => database.getDb()).not.toThrow();
    await afterRelaunchDelay();
    expect(electron.relaunch).not.toHaveBeenCalled();
    expect(readRestoreMarker(root)).toBeUndefined();
  });

  it('relaunches on the database you had when the swap fails after closing', async () => {
    const b = await backups.createBackup(db, 'manual', 'before-change');
    renameUnit('4 North Renamed');
    // Staging is done by the time solver work stops. Taking the staged copy away then lets the
    // close and the marker succeed and fails only the rename, as antivirus quarantining it would.
    const stopWork = () => rmSync(`${database.databasePath()}.restoring`);

    await expect(backups.restoreBackup(db, b.fileName, stopWork)).rejects.toThrow(
      'The backup could not be put in place. ShiftNurse is restarting on the database you had; nothing in it was changed. The backup file is no longer there.',
    );

    await afterRelaunchDelay();
    expect(electron.showErrorBox).toHaveBeenCalledTimes(1);
    expect(electron.showErrorBox.mock.calls[0]![0]).toBe('The backup was not restored');
    expect(electron.relaunch).toHaveBeenCalledTimes(1);
    expect(electron.exit).toHaveBeenCalledWith(0);
    expect(unitNameOnDisk()).toBe('4 North Renamed');
    // The marker was written just before the rename; left behind, the next launch would audit
    // a restore that never happened.
    expect(readRestoreMarker(root)).toBeUndefined();
  });

  it('restores a backup an older version saved in WAL mode', async () => {
    const b = await backups.createBackup(db, 'manual', 'before-change');
    const legacy = new BetterSqlite(b.path);
    legacy.pragma('journal_mode = WAL');
    legacy.close();
    renameUnit('4 North Renamed');

    await backups.restoreBackup(db, b.fileName, () => {});
    await afterRelaunchDelay();

    expect(electron.showErrorBox).not.toHaveBeenCalled();
    expect(unitNameOnDisk()).toBe('4 North');
  });

  it('refuses a second restore while one is under way', async () => {
    const b = await backups.createBackup(db, 'manual', 'before-change');
    const first = backups.restoreBackup(db, b.fileName, () => {});

    await expect(backups.restoreBackup(db, b.fileName, () => {})).rejects.toThrow(
      'A restore or start over is already under way.',
    );
    await first;
    await afterRelaunchDelay();
  });
});

describe('starting over', () => {
  it.skipIf(CANNOT_CHMOD)('relaunches when start over cannot remove the database', async () => {
    const stopWork = () => chmodSync(root, 0o555);

    await expect(backups.resetDatabase(db, stopWork)).rejects.toThrow(
      /^The database could not be removed\. ShiftNurse is restarting on the database you had; nothing in it was changed\./,
    );

    await afterRelaunchDelay();
    expect(electron.showErrorBox.mock.calls[0]![0]).toBe('Start over did not finish');
    expect(electron.relaunch).toHaveBeenCalledTimes(1);
    expect(electron.exit).toHaveBeenCalledWith(0);
    chmodSync(root, 0o755);
    expect(unitNameOnDisk()).toBe('4 North');
  });
});

describe('the daily copies', () => {
  it('keeps the newest 14 daily copies', async () => {
    const seed = await backups.createBackup(db, 'manual', 'seed');
    const dir = join(root, 'backups');
    const now = Date.now();
    // Days 1..15 before today; the listing reads the date from the name, not the content.
    const names = Array.from({ length: 15 }, (_, i) =>
      backupFileName('daily', 'd', now - (i + 1) * DAY),
    );
    for (const name of names) copyFileSync(seed.path, join(dir, name));

    await backups.ensureDailyBackup(db);

    // Backups only: verifying a copy read-only can leave its `-wal`/`-shm` beside it.
    const daily = backupNames().filter((n) => /^daily-.*\.sqlite$/.test(n));
    // 15 old + today's = 16; keeping 14 removes the two oldest (14 and 15 days ago).
    expect(daily).toHaveLength(14);
    expect(daily).not.toContain(names[13]);
    expect(daily).not.toContain(names[14]);
    for (const name of names.slice(0, 13)) expect(daily).toContain(name);
  });

  it('opens even when the backups folder cannot be tidied', () => {
    // A directory where a stale partial file would be: removing it without `recursive` throws.
    mkdirSync(join(root, 'backups', 'daily-x-1.sqlite.partial'), { recursive: true });
    const log = { info: vi.fn(), error: vi.fn() };

    const stop = backups.startDailyBackups(db, log);

    expect(log.error).toHaveBeenCalled();
    expect(log.error.mock.calls[0]![0]).toMatch(/^\[backup\] tidying the backups folder failed/);
    stop();
  });

  it('opens even when a removal a crash interrupted cannot be finished', () => {
    // An unrecorded removal is put back by renaming it over its old name; a folder in the way
    // makes that rename fail.
    const dir = join(root, 'backups');
    mkdirSync(join(dir, 'daily-y-2.sqlite'), { recursive: true });
    writeFileSync(join(dir, 'daily-y-2.sqlite', 'inside'), 'x');
    writeFileSync(join(dir, 'daily-y-2.sqlite.purging'), 'x');
    const log = { info: vi.fn(), error: vi.fn() };

    const stop = backups.startDailyBackups(db, log);

    expect(log.error.mock.calls[0]![0]).toMatch(/^\[backup\] tidying the backups folder failed/);
    stop();
  });
});
