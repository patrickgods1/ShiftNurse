/**
 * Database backups: on publish, once a day, on demand, and the one-click restore.
 *
 * The schedule is the unit's only copy of what was promised to staff. A corrupted or
 * accidentally wiped database the week before a period starts is not recoverable from
 * memory, so every publish — the moment the data becomes a promise — writes a full copy
 * first, and the app keeps a rolling set of daily copies for everything else. Backups use
 * SQLite's online backup API through better-sqlite3, so they are consistent snapshots even
 * with WAL pages not yet checkpointed; a plain file copy of a WAL database is not.
 *
 * Restore is deliberately blunt: save the live file as a `pre-restore` backup, copy the
 * chosen backup over it, relaunch. Swapping the connection under a running renderer with
 * cached queries would be cleverer and wrong in more ways.
 *
 * Deleting a backup is soft (see `backup-files.ts`): it waits in the trash for 30 days, and
 * the launch sweep purges it after that unless the manager deletes it permanently first.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { today } from '@shiftnurse/core';
import type { MigrationStatus, OpenedDatabase, ShiftNurseDb } from '@shiftnurse/db';
import { recordAudit, transact } from '@shiftnurse/db';
import { app } from 'electron';
import type { BackupInfo, DeletedBackupInfo } from '../shared/api.js';
import {
  type BackupKind,
  backupFileName,
  dailyBackupDue,
  listBackupFiles,
  listTrash,
  readBackup,
  replaceDatabaseFile,
} from './backup-files.js';
import {
  deleteBackupIn,
  purgeDeletedBackupIn,
  purgeExpiredBackupsIn,
  undeleteBackupIn,
} from './backup-trash.js';
import { closeAppDatabase, databasePath, getSqlite } from './database.js';

/** Actor for audit rows written by the backup job itself. */
const ACTOR = 'manager';
const DAILY_KEEP = 14;
/** How often a running app checks whether today's copy is still to take. */
const DAILY_CHECK_MS = 60 * 60 * 1000;

export function backupsDir(): string {
  return join(app.getPath('userData'), 'backups');
}

/** Newest first. */
export function listBackups(): BackupInfo[] {
  return listBackupFiles(backupsDir());
}

/** Copy the database through SQLite's online backup API; no audit row yet. */
async function writeBackupFile(
  sqlite: OpenedDatabase['sqlite'],
  kind: BackupKind,
  label: string,
): Promise<BackupInfo> {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const fileName = backupFileName(kind, label, Date.now());
  await sqlite.backup(join(dir, fileName));
  const result = readBackup(dir, fileName);
  if (!result) throw new Error(`Backup ${fileName} was written but cannot be read back`);
  return result;
}

/**
 * The audit row for a backup, written *after* the file exists: a backup that failed must not
 * be recorded as taken, and the record must live in the live database (not the copy) so the
 * next backup's audit trail is complete.
 */
export function recordBackup(db: ShiftNurseDb, backup: BackupInfo): void {
  recordAudit(db, {
    entityType: 'backup',
    entityId: backup.fileName,
    action: 'backup',
    actor: ACTOR,
    after: { kind: backup.kind, path: backup.path, bytes: backup.bytes },
    at: backup.createdAt,
  });
}

/** Write one backup and audit it. */
export async function createBackup(
  db: ShiftNurseDb,
  kind: Exclude<BackupKind, 'pre-migrate'>,
  label: string,
): Promise<BackupInfo> {
  const result = await writeBackupFile(getSqlite(), kind, label);
  recordBackup(db, result);
  return result;
}

/**
 * The copy taken before an update migrates the database — the only way back if a migration
 * goes wrong on a real unit's data. It runs before the schema is current, so it cannot be
 * audited yet: the caller records it with `recordBackup` once the migrations have run.
 * A fresh file has nothing to lose and is not copied.
 */
export async function backupBeforeMigrate(
  sqlite: OpenedDatabase['sqlite'],
  status: MigrationStatus,
): Promise<BackupInfo | undefined> {
  if (status.fresh || status.pending === 0) return undefined;
  return writeBackupFile(sqlite, 'pre-migrate', `before-v${app.getVersion()}`);
}

/** Keep the newest `DAILY_KEEP` daily backups; publish and manual backups are never pruned. */
function pruneDaily(): void {
  const daily = listBackups().filter((b) => b.kind === 'daily');
  for (const stale of daily.slice(DAILY_KEEP)) rmSync(stale.path, { force: true });
}

/** Once per local calendar day; a no-op when today's copy already exists. */
export async function ensureDailyBackup(db: ShiftNurseDb): Promise<BackupInfo | undefined> {
  const now = new Date();
  if (!dailyBackupDue(listBackups(), now)) return undefined;
  const created = await createBackup(db, 'daily', today(now));
  pruneDaily();
  return created;
}

/**
 * Take the daily copy now and keep checking while the app runs: a ward PC can leave the app
 * open for a week, and a copy only at launch would then be a week old. Returns the stop.
 */
export function startDailyBackups(
  db: ShiftNurseDb,
  log: { info(msg: string): void; error(msg: string): void },
): () => void {
  const run = () =>
    void ensureDailyBackup(db).then(
      (b) => b && log.info(`[backup] daily backup written to ${b.path}`),
      (err) => log.error(`[backup] daily backup failed: ${err}`),
    );
  run();
  const timer = setInterval(run, DAILY_CHECK_MS);
  return () => clearInterval(timer);
}

/** Deleted backups still in the trash, most recently deleted first. */
export function listDeletedBackups(): DeletedBackupInfo[] {
  return listTrash(backupsDir());
}

/** See `backup-trash.ts`: the audited trash, here on the real backup folder and clock. */
export function deleteBackup(
  db: ShiftNurseDb,
  fileName: string,
  options: { permanent?: boolean } = {},
): void {
  deleteBackupIn(db, backupsDir(), fileName, options, Date.now());
}

export function undeleteBackup(db: ShiftNurseDb, fileName: string): BackupInfo {
  return undeleteBackupIn(db, backupsDir(), fileName);
}

export function purgeDeletedBackup(db: ShiftNurseDb, fileName: string): void {
  purgeDeletedBackupIn(db, backupsDir(), fileName);
}

export function purgeExpiredBackups(db: ShiftNurseDb): DeletedBackupInfo[] {
  return purgeExpiredBackupsIn(db, backupsDir(), Date.now());
}

function assertSqliteFile(path: string): void {
  if (!existsSync(path)) throw new Error(`Backup ${path} does not exist`);
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
      throw new Error(`${path} is not a SQLite database`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace the live database with a backup and relaunch. The live file is saved first as a
 * `pre-restore` backup, so a restore is itself reversible through the same screen. The
 * restore is audited in the *outgoing* database (the only one open); the incoming copy's
 * history starts where that backup left off.
 *
 * `stopWork` runs before the database closes (see `replaceLiveDatabase`).
 */
export async function restoreBackup(
  db: ShiftNurseDb,
  fileName: string,
  stopWork: () => void,
): Promise<BackupInfo> {
  const source = listBackups().find((b) => b.fileName === fileName);
  if (!source) throw new Error(`Unknown backup ${fileName}`);
  assertSqliteFile(source.path);
  const safety = await createBackup(db, 'pre-restore', fileName.replace(/\.sqlite$/, ''));
  transact(db, (tx) =>
    recordAudit(tx, {
      entityType: 'backup',
      entityId: fileName,
      action: 'restore',
      actor: ACTOR,
      before: { live: databasePath(), savedAs: safety.fileName },
      after: { restoredFrom: source.path },
    }),
  );
  replaceLiveDatabase(source.path, stopWork);
  return safety;
}

/**
 * Start over: save the live database as a `pre-reset` backup, delete it and relaunch into the
 * first-run welcome screen. Its audit trail cannot outlive it, so the backup is the record —
 * restoring it from Settings › Backups undoes the reset, audit log and all.
 */
export async function resetDatabase(db: ShiftNurseDb, stopWork: () => void): Promise<BackupInfo> {
  const safety = await createBackup(db, 'pre-reset', 'start-over');
  replaceLiveDatabase(undefined, stopWork);
  return safety;
}

/**
 * Close the live database, replace it with `source` (or delete it when there is none) and
 * relaunch. `stopWork` runs before the close: the relaunch goes through `app.exit`, which skips
 * `will-quit` — the hook that normally stops solver workers — so without it a running solve's
 * CP-SAT runner process would outlive the app.
 */
function replaceLiveDatabase(source: string | undefined, stopWork: () => void): void {
  stopWork();
  closeAppDatabase();
  replaceDatabaseFile(databasePath(), source);
  // Let the IPC reply reach the renderer before the process goes away.
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 250);
}
