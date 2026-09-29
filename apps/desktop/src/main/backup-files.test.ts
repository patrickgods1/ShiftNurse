import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listBackupFiles,
  listTrash,
  moveToTrash,
  purgeExpired,
  purgeFromTrash,
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
