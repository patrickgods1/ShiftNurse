import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupFileName,
  dailyBackupDue,
  listBackupFiles,
  listTrash,
  moveToTrash,
  purgeExpired,
  purgeFromTrash,
  replaceDatabaseFile,
  restoreFromTrash,
} from './backup-files.js';

const DAY = 86_400_000;
// 2026-09-28T12:00:00Z
const NOW = Date.UTC(2026, 8, 28, 12);
const MANUAL = 'manual-manual-1790000000000.sqlite';
const PUBLISH = 'publish-Sep_2026-1790000100000.sqlite';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiftnurse-backups-'));
  writeFileSync(join(dir, MANUAL), 'SQLite format 3\0manual');
  writeFileSync(join(dir, PUBLISH), 'SQLite format 3\0publish');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('backup trash', () => {
  it('takes a deleted backup off the list but keeps the file for 30 days', () => {
    const trashed = moveToTrash(dir, MANUAL, NOW);

    expect(listBackupFiles(dir).map((b) => b.fileName)).toEqual([PUBLISH]);
    expect(existsSync(trashed.path)).toBe(true);
    expect(trashed).toMatchObject({ fileName: MANUAL, kind: 'manual', deletedAt: NOW });
    // 28 Sep + 30 days = 28 Oct, same time of day.
    expect(trashed.purgeAt).toBe(Date.UTC(2026, 9, 28, 12));
    expect(listTrash(dir).map((b) => b.fileName)).toEqual([MANUAL]);
  });

  it('puts an undeleted backup back on the list unchanged', () => {
    moveToTrash(dir, MANUAL, NOW);
    const restored = restoreFromTrash(dir, MANUAL);

    expect(restored.fileName).toBe(MANUAL);
    expect(listTrash(dir)).toEqual([]);
    expect(listBackupFiles(dir).map((b) => b.fileName)).toEqual([PUBLISH, MANUAL]);
    expect(restored.bytes).toBe('SQLite format 3\0manual'.length);
  });

  it('keeps a backup deleted 29 days ago and purges one deleted 30 days ago', () => {
    moveToTrash(dir, MANUAL, NOW - 29 * DAY);
    moveToTrash(dir, PUBLISH, NOW - 30 * DAY);

    const purged = purgeExpired(dir, NOW);

    expect(purged.map((b) => b.fileName)).toEqual([PUBLISH]);
    expect(listTrash(dir).map((b) => b.fileName)).toEqual([MANUAL]);
  });

  it('deletes a trashed backup at once when the manager says delete permanently', () => {
    const trashed = moveToTrash(dir, MANUAL, NOW);
    purgeFromTrash(dir, MANUAL);

    expect(existsSync(trashed.path)).toBe(false);
    expect(listTrash(dir)).toEqual([]);
  });

  it('refuses names that are not backups in the folder', () => {
    expect(() => moveToTrash(dir, '../live.sqlite', NOW)).toThrow(/Unknown backup/);
    expect(() => moveToTrash(dir, 'manual-x-1790000000001.sqlite', NOW)).toThrow(/Unknown backup/);
    expect(() => restoreFromTrash(dir, MANUAL)).toThrow(/not in the trash/);
    expect(() => purgeFromTrash(dir, MANUAL)).toThrow(/not in the trash/);
  });

  it('will not undelete over a live backup of the same name', () => {
    moveToTrash(dir, MANUAL, NOW);
    writeFileSync(join(dir, MANUAL), 'SQLite format 3\0newer');

    expect(() => restoreFromTrash(dir, MANUAL)).toThrow(/already exists/);
  });

  it('ignores stray files in the trash folder', () => {
    mkdirSync(join(dir, 'trash'), { recursive: true });
    writeFileSync(join(dir, 'trash', 'notes.txt'), 'hello');

    expect(listTrash(dir)).toEqual([]);
    expect(purgeExpired(dir, NOW + 365 * DAY)).toEqual([]);
    expect(existsSync(join(dir, 'trash', 'notes.txt'))).toBe(true);
  });
});

describe('swapping the live database for a restore or a start over', () => {
  function live(): string {
    const path = join(dir, 'shiftnurse.sqlite');
    writeFileSync(path, 'SQLite format 3\0live');
    writeFileSync(`${path}-wal`, 'pages not yet checkpointed');
    writeFileSync(`${path}-shm`, 'index');
    return path;
  }

  it('puts the backup in place and drops the outgoing WAL, which would replay over it', () => {
    const path = live();
    replaceDatabaseFile(path, join(dir, MANUAL));
    expect(readFileSync(path, 'utf8')).toBe('SQLite format 3\0manual');
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(join(dir, MANUAL))).toBe(true);
  });

  it('deletes the live file for a start over, leaving the backups', () => {
    const path = live();
    replaceDatabaseFile(path, undefined);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(listBackupFiles(dir)).toHaveLength(2);
  });

  it('leaves the live database untouched when the backup cannot be read', () => {
    const path = live();
    expect(() => replaceDatabaseFile(path, join(dir, 'gone.sqlite'))).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('SQLite format 3\0live');
    expect(existsSync(`${path}-wal`)).toBe(true);
  });
});

describe('the daily backup', () => {
  function daily(at: Date): void {
    writeFileSync(join(dir, backupFileName('daily', 'x', at.getTime())), 'SQLite format 3\0');
  }

  it('counts a copy taken just after midnight as today’s, late the same evening', () => {
    daily(new Date(2026, 8, 28, 0, 15));
    expect(dailyBackupDue(listBackupFiles(dir), new Date(2026, 8, 28, 23, 30))).toBe(false);
  });

  it('is due again once the local date turns over', () => {
    daily(new Date(2026, 8, 27, 23, 59));
    expect(dailyBackupDue(listBackupFiles(dir), new Date(2026, 8, 28, 0, 1))).toBe(true);
  });

  it('ignores manual and publish copies, which are not the daily rotation', () => {
    expect(dailyBackupDue(listBackupFiles(dir), new Date(NOW))).toBe(true);
  });
});

describe('backup names', () => {
  it('lists the copy taken before an upgrade migrated the database', () => {
    const name = backupFileName('pre-migrate', 'v0.1.0 → 14 changes', NOW);
    writeFileSync(join(dir, name), 'SQLite format 3\0');
    expect(listBackupFiles(dir).find((b) => b.fileName === name)?.kind).toBe('pre-migrate');
  });
});
