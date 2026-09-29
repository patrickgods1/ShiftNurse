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

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { recordAudit, type ShiftNurseDb, transact } from '@shiftnurse/db';
import { app } from 'electron';
import type { BackupInfo, DeletedBackupInfo } from '../shared/api.js';
import {
  deleteLiveBackup,
  listBackupFiles,
  listTrash,
  moveToTrash,
  purgeExpired,
  purgeFromTrash,
  readBackup,
  restoreFromTrash,
} from './backup-files.js';
import { closeAppDatabase, databasePath, getSqlite } from './database.js';

/** Actor for audit rows written by the backup job itself. */
const ACTOR = 'manager';
const DAILY_KEEP = 14;

export function backupsDir(): string {
  return join(app.getPath('userData'), 'backups');
}

function slug(text: string): string {
  return (
    text
      .replace(/[^\w-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'db'
  );
}

/** Newest first. */
export function listBackups(): BackupInfo[] {
  return listBackupFiles(backupsDir());
}

/**
 * Write one backup. The audit row is written *after* the file exists, in its own statement:
 * a backup that failed must not be recorded as taken, and the record must live in the live
 * database (not the copy) so the next backup's audit trail is complete.
 */
export async function createBackup(
  db: ShiftNurseDb,
  kind: 'publish' | 'daily' | 'manual' | 'pre-restore' | 'pre-reset',
  label: string,
): Promise<BackupInfo> {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const createdAt = Date.now();
  const fileName = `${kind}-${slug(label)}-${createdAt}.sqlite`;
  const path = join(dir, fileName);
  await getSqlite().backup(path);
  const result = readBackup(backupsDir(), fileName);
  if (!result) throw new Error(`Backup ${fileName} was written but cannot be read back`);
  recordAudit(db, {
    entityType: 'backup',
    entityId: fileName,
    action: 'backup',
    actor: ACTOR,
    after: { kind, path, bytes: result.bytes },
    at: createdAt,
  });
  return result;
}

/** Keep the newest `DAILY_KEEP` daily backups; publish and manual backups are never pruned. */
function pruneDaily(): void {
  const daily = listBackups().filter((b) => b.kind === 'daily');
  for (const stale of daily.slice(DAILY_KEEP)) rmSync(stale.path, { force: true });
}

/** Once per calendar day on the host clock; a no-op when today's copy already exists. */
export async function ensureDailyBackup(db: ShiftNurseDb): Promise<BackupInfo | undefined> {
  const today = new Date().toISOString().slice(0, 10);
  const existing = listBackups().find(
    (b) => b.kind === 'daily' && new Date(b.createdAt).toISOString().slice(0, 10) === today,
  );
  if (existing) return undefined;
  const created = await createBackup(db, 'daily', today);
  pruneDaily();
  return created;
}

/** Deleted backups still in the trash, most recently deleted first. */
export function listDeletedBackups(): DeletedBackupInfo[] {
  return listTrash(backupsDir());
}

/**
 * Delete a backup. By default it goes to the trash for `TRASH_RETENTION_DAYS`; `permanent`
 * is the manager's override and removes the file now. Audited after the file operation, so
 * a failed delete is never recorded as done.
 */
export function deleteBackup(
  db: ShiftNurseDb,
  fileName: string,
  options: { permanent?: boolean } = {},
): void {
  if (options.permanent) {
    const gone = deleteLiveBackup(backupsDir(), fileName);
    auditDelete(db, gone, { permanent: true });
    return;
  }
  const trashed = moveToTrash(backupsDir(), fileName, Date.now());
  auditDelete(db, trashed, { permanent: false, purgeAt: trashed.purgeAt });
}

/** Take a backup back out of the trash onto the list. */
export function undeleteBackup(db: ShiftNurseDb, fileName: string): BackupInfo {
  const restored = restoreFromTrash(backupsDir(), fileName);
  transact(db, (tx) =>
    recordAudit(tx, {
      entityType: 'backup',
      entityId: fileName,
      action: 'update',
      actor: ACTOR,
      before: { inTrash: true },
      after: { inTrash: false, path: restored.path },
    }),
  );
  return restored;
}

/** Delete a trashed backup now instead of waiting out its retention. */
export function purgeDeletedBackup(db: ShiftNurseDb, fileName: string): void {
  const gone = purgeFromTrash(backupsDir(), fileName);
  auditDelete(db, gone, { permanent: true });
}

/** The launch sweep: trashed backups past their retention are removed for good. */
export function purgeExpiredBackups(db: ShiftNurseDb): DeletedBackupInfo[] {
  const purged = purgeExpired(backupsDir(), Date.now());
  for (const b of purged) auditDelete(db, b, { permanent: true, expired: true });
  return purged;
}

function auditDelete(db: ShiftNurseDb, backup: BackupInfo, after: Record<string, unknown>): void {
  transact(db, (tx) =>
    recordAudit(tx, {
      entityType: 'backup',
      entityId: backup.fileName,
      action: 'delete',
      actor: ACTOR,
      before: { kind: backup.kind, createdAt: backup.createdAt, bytes: backup.bytes },
      after,
    }),
  );
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
  const live = databasePath();
  // WAL and shm files belong to the outgoing database; left behind they would be replayed
  // over the restored file (or a fresh one) on next open.
  for (const suffix of ['-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true });
  if (source === undefined) rmSync(live, { force: true });
  else copyFileSync(source, live);
  // Let the IPC reply reach the renderer before the process goes away.
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 250);
}
