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
 * chosen backup in beside it, close the connection, rename the copy over the live file,
 * relaunch. Swapping the connection under a running renderer with cached queries would be
 * cleverer and wrong in more ways. The copy goes in *before* the close, so a full disk or a
 * vanished backup changes nothing and the app keeps running; once the connection is closed,
 * every path relaunches, onto the old file if the swap failed. One restore or start over runs at
 * a time.
 *
 * Deleting a backup is soft (see `backup-files.ts`): it waits in the trash for 30 days, and
 * the launch sweep purges it after that unless the manager deletes it permanently first.
 * Daily copies beyond the newest 14 are removed for good, each with an audit row (`pruned: true`);
 * publish and manual copies are never pruned.
 */

import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { today } from '@shiftnurse/core';
import type { MigrationStatus, OpenedDatabase, ShiftNurseDb } from '@shiftnurse/db';
import { recordAudit } from '@shiftnurse/db';
import Database from 'better-sqlite3';
import { app, dialog } from 'electron';
import type { BackupInfo, DeletedBackupInfo } from '../shared/api.js';
import {
  type BackupKind,
  backupFileName,
  clearRestoreMarker,
  commitDatabaseFile,
  dailyBackupDue,
  listBackupFiles,
  listTrash,
  PARTIAL_SUFFIX,
  readBackup,
  removeStalePartials,
  restoreRefusal,
  stageDatabaseFile,
  verifyDatabaseFile,
  writeRestoreMarker,
} from './backup-files.js';
import {
  deleteBackupIn,
  pruneDailyBackupsIn,
  purgeDeletedBackupIn,
  purgeExpiredBackupsIn,
  settleInterruptedRemovals,
  undeleteBackupIn,
} from './backup-trash.js';
import { closeAppDatabase, databasePath, getSqlite, resolveMigrationsFolder } from './database.js';
import { isSmokeRun } from './smoke-flag.js';

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

const inFlight = new Set<Promise<unknown>>();

/**
 * Resolves, never rejects, once every backup write started so far has settled. Quitting while
 * one is mid-copy would leave a `.partial` file and no backup, so the quit waits on this.
 */
export async function backupsInFlight(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

/**
 * Copy the database through SQLite's online backup API; no audit row yet. Written under a
 * `.partial` name and renamed only once it verifies, so a crash or full disk never leaves a
 * half-copied file that Settings › Backups lists as a good backup.
 */
function writeBackupFile(
  sqlite: OpenedDatabase['sqlite'],
  kind: BackupKind,
  label: string,
): Promise<BackupInfo> {
  const write = copyBackup(sqlite, kind, label);
  inFlight.add(write);
  const done = () => inFlight.delete(write);
  write.then(done, done);
  return write;
}

async function copyBackup(
  sqlite: OpenedDatabase['sqlite'],
  kind: BackupKind,
  label: string,
): Promise<BackupInfo> {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const fileName = backupFileName(kind, label, Date.now());
  const partial = join(dir, `${fileName}${PARTIAL_SUFFIX}`);
  try {
    await sqlite.backup(partial);
    // The copy inherits the live file's WAL mode, and a read-only open of a WAL file (the verify
    // below, or a later restore's) leaves `-wal`/`-shm` files beside it that it cannot remove.
    // A backup is never written again, so it needs no WAL; `openDatabase` turns WAL back on for
    // a restored copy.
    const copy = new Database(partial, { fileMustExist: true });
    try {
      copy.pragma('journal_mode = DELETE');
    } finally {
      copy.close();
    }
    const verdict = verifyDatabaseFile(partial, resolveMigrationsFolder());
    if (!verdict.ok) throw new Error(`Backup ${fileName} failed verification: ${verdict.detail}`);
    renameSync(partial, join(dir, fileName));
  } catch (err) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${partial}${suffix}`, { force: true });
    throw err;
  }
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
function pruneDaily(db: ShiftNurseDb): void {
  pruneDailyBackupsIn(db, backupsDir(), DAILY_KEEP);
}

/** Once per local calendar day; a no-op when today's copy already exists. */
export async function ensureDailyBackup(db: ShiftNurseDb): Promise<BackupInfo | undefined> {
  const now = new Date();
  if (!dailyBackupDue(listBackups(), now)) return undefined;
  const created = await createBackup(db, 'daily', today(now));
  pruneDaily(db);
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
  // Tidying is housekeeping: a Windows EBUSY on one stray file must not stop the app opening.
  const tidy = (step: () => unknown) => {
    try {
      step();
    } catch (err) {
      log.error(
        `[backup] tidying the backups folder failed: ${(err as NodeJS.ErrnoException).code ?? err}`,
      );
    }
  };
  tidy(() => removeStalePartials(backupsDir()));
  tidy(() => settleInterruptedRemovals(db, backupsDir()));
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

/**
 * One restore or start over at a time. Two overlapping calls (a double-click) would both take
 * safety copies and both swap, and the audit row could name a different backup from the file in
 * place. Never cleared once the connection has closed: the app is relaunching then, and nothing
 * else may start.
 */
let replacing = false;
let closed = false;

function beginReplacing(): void {
  if (replacing) throw new Error('A restore or start over is already under way.');
  replacing = true;
}

function endReplacing(): void {
  if (!closed) replacing = false;
}

/**
 * Replace the live database with a backup and relaunch. The live file is saved first as a
 * `pre-restore` backup, so a restore is itself reversible through the same screen. The
 * backup is verified first — a refusal takes no safety copy and touches nothing. The restore is
 * audited in the *restored* database: a marker beside the live file is consumed by
 * `openAppDatabase`, because a row written to the outgoing database would be thrown away. The
 * marker is written after the close, immediately before the swap, so a crash any earlier
 * leaves nothing that could be read as a restore.
 *
 * `stopWork` runs before the database closes (see `replaceLiveDatabase`).
 */
export async function restoreBackup(
  db: ShiftNurseDb,
  fileName: string,
  stopWork: () => void,
): Promise<BackupInfo> {
  beginReplacing();
  try {
    const source = listBackups().find((b) => b.fileName === fileName);
    if (!source) throw new Error(`Unknown backup ${fileName}`);
    const verdict = verifyDatabaseFile(source.path, resolveMigrationsFolder());
    const refusal = restoreRefusal(verdict);
    if (refusal) throw new Error(refusal);
    const safety = await createBackup(db, 'pre-restore', fileName.replace(/\.sqlite$/, ''));
    const liveDir = dirname(databasePath());
    // A daily or manual copy may still be running; closing the database under it would corrupt
    // it. Nothing from here to the swap awaits, so no new copy can start in between.
    await backupsInFlight();
    try {
      replaceLiveDatabase(source.path, stopWork, () =>
        writeRestoreMarker(liveDir, {
          fileName,
          restoredFrom: source.path,
          savedAs: safety.fileName,
          at: Date.now(),
        }),
      );
    } catch (err) {
      // The swap did not happen, so there is no restore to audit.
      try {
        clearRestoreMarker(liveDir);
      } catch (clearErr) {
        console.error('[backup] could not remove the restore marker:', clearErr);
      }
      throw err;
    }
    return safety;
  } finally {
    endReplacing();
  }
}

/**
 * Start over: save the live database as a `pre-reset` backup, delete it and relaunch into the
 * first-run welcome screen. Its audit trail cannot outlive it, so the backup is the record —
 * restoring it from Settings › Backups undoes the reset, audit log and all.
 */
export async function resetDatabase(db: ShiftNurseDb, stopWork: () => void): Promise<BackupInfo> {
  beginReplacing();
  try {
    const safety = await createBackup(db, 'pre-reset', 'start-over');
    await backupsInFlight();
    replaceLiveDatabase(undefined, stopWork);
    return safety;
  } finally {
    endReplacing();
  }
}

interface FailureWords {
  title: string;
  /** Leads the message; the cause follows it. */
  lead: string;
}

const RESTORE_WORDS: FailureWords = {
  title: 'The backup was not restored',
  lead: 'The backup could not be put in place. ShiftNurse is restarting on the database you had; nothing in it was changed.',
};

const RESET_WORDS: FailureWords = {
  title: 'Start over did not finish',
  lead: 'The database could not be removed. ShiftNurse is restarting on the database you had; nothing in it was changed.',
};

/**
 * Why a file step failed, in words for the manager. Only the error code is read: the message
 * carries paths and, for a SQLite error, possibly data, and these words reach a dialog.
 */
function causeWords(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOSPC':
      return 'The disk is full.';
    case 'EBUSY':
    case 'EPERM':
    case 'EACCES':
      return 'Another program (often antivirus or backup software) is using the file, or the folder is read-only.';
    case 'ENOENT':
      return 'The backup file is no longer there.';
    default:
      return `(${code ?? 'unknown error'})`;
  }
}

/**
 * Put `source` in place of the live database (or delete it when there is none) and relaunch.
 *
 * The backup is staged beside the live file while the connection is still open, so a failed
 * copy changes nothing and the app carries on. `stopWork` runs before the close: the relaunch
 * goes through `app.exit`, which skips `will-quit` — the hook that normally stops solver workers
 * — so without it a running solve's CP-SAT runner process would outlive the app. Once the
 * connection is closed every IPC call would fail with "Database not opened", so from there every
 * path ends in a scheduled relaunch, failure or not. A failure after the close leaves the old
 * file intact: closing the last connection checkpoints the WAL into the main file before
 * `commitDatabaseFile` deletes the WAL, so "nothing in it was changed" is true.
 */
function replaceLiveDatabase(
  source: string | undefined,
  stopWork: () => void,
  onSwap?: () => void,
): void {
  const words = source === undefined ? RESET_WORDS : RESTORE_WORDS;
  let staged: string | undefined;
  try {
    staged = source === undefined ? undefined : stageDatabaseFile(databasePath(), source);
  } catch (err) {
    console.error('[backup] staging the backup failed:', err);
    throw new Error(
      `The backup could not be copied into place, so nothing was restored. ${causeWords(err)}`,
    );
  }
  try {
    stopWork();
  } catch (err) {
    console.error('[backup] stopping solver work failed:', err);
  }
  let failure: unknown;
  try {
    closed = true;
    closeAppDatabase();
    onSwap?.();
    commitDatabaseFile(databasePath(), staged);
  } catch (err) {
    failure = err;
  } finally {
    const message = failure === undefined ? undefined : `${words.lead} ${causeWords(failure)}`;
    // Let the IPC reply reach the renderer before the process goes away.
    setTimeout(() => {
      if (message !== undefined && !isSmokeRun()) dialog.showErrorBox(words.title, message);
      app.relaunch();
      app.exit(0);
    }, 250);
  }
  if (failure !== undefined) {
    console.error('[backup] swapping the database file failed:', failure);
    if (staged !== undefined) {
      try {
        rmSync(staged, { force: true });
      } catch (err) {
        console.error('[backup] could not remove the staged backup:', err);
      }
    }
    throw new Error(`${words.lead} ${causeWords(failure)}`);
  }
}
