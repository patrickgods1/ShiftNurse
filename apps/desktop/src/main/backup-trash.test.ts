/**
 * The audited half of deleting backups: every trash, restore and purge leaves one audit row in
 * the live database, written only once the file operation has succeeded — a delete that failed
 * must never be on the record as done.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditHistoryFor, type OpenedDatabase, openTestDatabase } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackupFiles, listTrash } from './backup-files.js';
import {
  deleteBackupIn,
  purgeDeletedBackupIn,
  purgeExpiredBackupsIn,
  settleInterruptedRemovals,
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

describe('when a deletion cannot be recorded', () => {
  // A trigger that refuses every insert is how a full disk or a locked audit table looks to the
  // caller: the statement throws after the file has already moved.
  const breakAudit = () =>
    handle.sqlite.exec(
      "CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
  const auditRows = () =>
    handle.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as {
      n: number;
    };

  it('leaves the backup in place when the deletion cannot be recorded', () => {
    breakAudit();
    expect(() => deleteBackupIn(handle.db, dir, MANUAL, {}, NOW)).toThrow(/audit down/);
    expect(existsSync(join(dir, MANUAL))).toBe(true);
    expect(listTrash(dir)).toEqual([]);
    expect(auditRows().n).toBe(0);
  });

  it('keeps a permanent deletion from happening when it cannot be recorded', () => {
    breakAudit();
    expect(() => deleteBackupIn(handle.db, dir, MANUAL, { permanent: true }, NOW)).toThrow(
      /audit down/,
    );
    expect(readFileSync(join(dir, MANUAL), 'utf8')).toBe('SQLite format 3\0manual');
    expect(readdirSync(dir).filter((n) => n.endsWith('.purging'))).toEqual([]);
    expect(auditRows().n).toBe(0);
  });

  it('keeps the backup in the trash when putting it back cannot be recorded', () => {
    const trashed = deleteBackupIn(handle.db, dir, MANUAL, {}, NOW);
    const before = auditRows().n;
    breakAudit();
    expect(() => undeleteBackupIn(handle.db, dir, MANUAL)).toThrow(/audit down/);
    expect(existsSync(trashed.path)).toBe(true);
    expect(existsSync(join(dir, MANUAL))).toBe(false);
    expect(auditRows().n).toBe(before);
  });

  it('keeps a trashed backup when its permanent deletion cannot be recorded', () => {
    const trashed = deleteBackupIn(handle.db, dir, MANUAL, {}, NOW);
    const before = auditRows().n;
    breakAudit();
    expect(() => purgeDeletedBackupIn(handle.db, dir, MANUAL)).toThrow(/audit down/);
    expect(readFileSync(trashed.path, 'utf8')).toBe('SQLite format 3\0manual');
    expect(readdirSync(join(dir, 'trash')).filter((n) => n.endsWith('.purging'))).toEqual([]);
    expect(listTrash(dir).map((b) => b.fileName)).toEqual([MANUAL]);
    expect(auditRows().n).toBe(before);
  });

  it('keeps the first removal on the record when a later removal cannot be recorded', () => {
    deleteBackupIn(handle.db, dir, MANUAL, {}, NOW - 32 * DAY);
    deleteBackupIn(handle.db, dir, PUBLISH, {}, NOW - 31 * DAY);
    const before = auditRows().n;
    // Let the first removal's audit through and refuse the second's.
    handle.sqlite.exec(
      `CREATE TRIGGER refuse_second BEFORE INSERT ON audit_log
       WHEN NEW.entity_id = '${MANUAL}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
    );
    // The trash lists the most recently deleted first, so PUBLISH goes first and MANUAL fails.
    expect(() => purgeExpiredBackupsIn(handle.db, dir, NOW)).toThrow(/audit down/);
    expect(listTrash(dir).map((b) => b.fileName)).toEqual([MANUAL]);
    expect(readdirSync(join(dir, 'trash')).filter((n) => n.endsWith('.purging'))).toEqual([]);
    expect(history(PUBLISH)[0]?.after).toEqual({ permanent: true, expired: true });
    expect(history(MANUAL).map((e) => e.action)).toEqual(['delete']);
    expect(auditRows().n).toBe(before + 1);
  });
});

describe('a removal a crash interrupted', () => {
  it('is finished at the next launch when it was on the record', () => {
    const trashed = deleteBackupIn(handle.db, dir, MANUAL, {}, NOW);
    // The crash came after the audit row and before the delete.
    renameSync(trashed.path, `${trashed.path}.purging`);
    handle.sqlite
      .prepare(
        `INSERT INTO audit_log (id, entity_type, entity_id, action, actor, after)
         VALUES ('purge-1', 'backup', ?, 'delete', 'manager', '{"permanent":true}')`,
      )
      .run(MANUAL);
    settleInterruptedRemovals(handle.db, dir);
    expect(readdirSync(join(dir, 'trash'))).toEqual([]);
  });

  it('puts the backup back when the removal was never recorded', () => {
    const trashed = deleteBackupIn(handle.db, dir, MANUAL, {}, NOW);
    renameSync(trashed.path, `${trashed.path}.purging`);
    renameSync(join(dir, PUBLISH), `${join(dir, PUBLISH)}.purging`);
    settleInterruptedRemovals(handle.db, dir);
    expect(listTrash(dir).map((b) => b.fileName)).toEqual([MANUAL]);
    expect(listBackupFiles(dir).map((b) => b.fileName)).toEqual([PUBLISH]);
  });
});
