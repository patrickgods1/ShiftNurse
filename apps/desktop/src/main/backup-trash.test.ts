/**
 * The audited half of deleting backups: every trash, restore and purge leaves one audit row in
 * the live database, written only once the file operation has succeeded — a delete that failed
 * must never be on the record as done.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditHistoryFor, type OpenedDatabase, openTestDatabase } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackupFiles, listTrash } from './backup-files.js';
import {
  deleteBackupIn,
  purgeDeletedBackupIn,
  purgeExpiredBackupsIn,
  undeleteBackupIn,
} from './backup-trash.js';

const DAY = 86_400_000;
// 2026-09-28T12:00:00Z
const NOW = Date.UTC(2026, 8, 28, 12);
const MANUAL = 'manual-manual-1790000000000.sqlite';
const PUBLISH = 'publish-Sep_2026-1790000100000.sqlite';

let dir: string;
let handle: OpenedDatabase;

const history = (fileName: string) => auditHistoryFor(handle.db, 'backup', fileName);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiftnurse-backup-trash-'));
  writeFileSync(join(dir, MANUAL), 'SQLite format 3\0manual');
  writeFileSync(join(dir, PUBLISH), 'SQLite format 3\0publish');
  handle = openTestDatabase();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('deleting a backup', () => {
  it('moves it to the trash and records when it will be removed', () => {
    deleteBackupIn(handle.db, dir, MANUAL, {}, NOW);
    expect(listTrash(dir).map((b) => b.fileName)).toEqual([MANUAL]);
    const [entry] = history(MANUAL);
    expect(entry).toMatchObject({ action: 'delete', actor: 'manager' });
    expect(entry?.before).toMatchObject({ kind: 'manual' });
    // 28 Sep + 30 days: 28 Oct, same time of day.
    expect(entry?.after).toEqual({ permanent: false, purgeAt: Date.UTC(2026, 9, 28, 12) });
  });

  it('removes it for good when the manager says so, on the record as permanent', () => {
    deleteBackupIn(handle.db, dir, MANUAL, { permanent: true }, NOW);
    expect(listBackupFiles(dir).map((b) => b.fileName)).toEqual([PUBLISH]);
    expect(listTrash(dir)).toEqual([]);
    expect(history(MANUAL).map((e) => e.after)).toEqual([{ permanent: true }]);
  });

  it('records nothing when there is no such backup', () => {
    expect(() => deleteBackupIn(handle.db, dir, '../live.sqlite', {}, NOW)).toThrow(
      /Unknown backup/,
    );
    expect(history('../live.sqlite')).toEqual([]);
  });
});

describe('the trash', () => {
  it('puts a deleted backup back on the list, on the record', () => {
    deleteBackupIn(handle.db, dir, MANUAL, {}, NOW);
    undeleteBackupIn(handle.db, dir, MANUAL);
    expect(
      listBackupFiles(dir)
        .map((b) => b.fileName)
        .sort(),
    ).toEqual([MANUAL, PUBLISH].sort());
    // Newest first: the undelete, then the delete.
    expect(history(MANUAL).map((e) => e.action)).toEqual(['update', 'delete']);
    expect(history(MANUAL)[0]?.after).toMatchObject({ inTrash: false });
  });

  it('deletes a trashed backup now when asked, on the record as permanent', () => {
    const trashed = deleteBackupIn(handle.db, dir, MANUAL, {}, NOW);
    purgeDeletedBackupIn(handle.db, dir, MANUAL);
    expect(existsSync(trashed.path)).toBe(false);
    expect(history(MANUAL)[0]?.after).toEqual({ permanent: true });
  });
});

describe('the launch sweep', () => {
  it('removes only backups 30 days in the trash, each on the record as expired', () => {
    deleteBackupIn(handle.db, dir, MANUAL, {}, NOW - 31 * DAY);
    deleteBackupIn(handle.db, dir, PUBLISH, {}, NOW - 29 * DAY);
    const purged = purgeExpiredBackupsIn(handle.db, dir, NOW);
    expect(purged.map((b) => b.fileName)).toEqual([MANUAL]);
    expect(listTrash(dir).map((b) => b.fileName)).toEqual([PUBLISH]);
    expect(history(MANUAL)[0]?.after).toEqual({ permanent: true, expired: true });
    expect(history(PUBLISH).map((e) => e.action)).toEqual(['delete']);
  });

  it('does nothing, and records nothing, when the trash is empty', () => {
    expect(purgeExpiredBackupsIn(handle.db, dir, NOW)).toEqual([]);
    expect(history(MANUAL)).toEqual([]);
  });
});
