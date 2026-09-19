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
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { recordAudit, type ShiftNurseDb, transact } from '@shiftnurse/db';
import { app } from 'electron';
import type { BackupInfo } from '../shared/api.js';
import { closeAppDatabase, databasePath, getSqlite } from './database.js';

/** Actor for audit rows written by the backup job itself. */
const ACTOR = 'manager';
const DAILY_KEEP = 14;
const BACKUP_RE = /^(publish|daily|manual|pre-restore)-(.*)-(\d{13})\.sqlite$/;

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

function info(fileName: string): BackupInfo | undefined {
  const m = BACKUP_RE.exec(fileName);
  if (!m) return undefined;
  const path = join(backupsDir(), fileName);
  return {
    fileName,
    path,
    kind: m[1]!,
    createdAt: Number(m[3]),
    bytes: statSync(path).size,
  };
}

/** Newest first. */
export function listBackups(): BackupInfo[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(info)
    .filter((b): b is BackupInfo => b !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Write one backup. The audit row is written *after* the file exists, in its own statement:
 * a backup that failed must not be recorded as taken, and the record must live in the live
 * database (not the copy) so the next backup's audit trail is complete.
 */
export async function createBackup(
  db: ShiftNurseDb,
  kind: 'publish' | 'daily' | 'manual' | 'pre-restore',
  label: string,
): Promise<BackupInfo> {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const createdAt = Date.now();
  const fileName = `${kind}-${slug(label)}-${createdAt}.sqlite`;
  const path = join(dir, fileName);
  await getSqlite().backup(path);
  const result = info(fileName);
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
 */
export async function restoreBackup(db: ShiftNurseDb, fileName: string): Promise<BackupInfo> {
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
  closeAppDatabase();
  const live = databasePath();
  // WAL and shm files belong to the outgoing database; left behind they would be replayed
  // over the restored file on next open.
  for (const suffix of ['-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true });
  copyFileSync(source.path, live);
  // Let the IPC reply reach the renderer before the process goes away.
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 250);
  return safety;
}
