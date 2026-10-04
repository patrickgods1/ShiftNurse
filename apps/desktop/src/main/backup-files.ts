/**
 * The backup folder on disk: which files are backups, and the trash a deleted one waits in.
 *
 * A backup is the only way back from a bad restore or a wiped database, so deleting one is
 * soft: the file moves to `trash/` and stays restorable for `TRASH_RETENTION_DAYS` before the
 * launch sweep removes it. "Delete permanently" is the manager's explicit override. The
 * deletion time is written into the trashed file's name (`<deletedAt>-<fileName>`) rather than
 * read from the file's mtime, which a rename keeps and a copy or sync tool can change.
 *
 * No Electron here — every function takes the folder — so the file logic is testable against
 * a temp directory; `backups.ts` supplies the real `userData` path and the audit rows.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { today } from '@shiftnurse/core';
import { migrationStatus } from '@shiftnurse/db';
import Database from 'better-sqlite3';
import type { BackupInfo, DeletedBackupInfo } from '../shared/api.js';

export const TRASH_RETENTION_DAYS = 30;
/** The name a file wears while its permanent removal is being recorded. */
export const PURGING_SUFFIX = '.purging';
const DAY_MS = 86_400_000;

export type BackupKind =
  | 'publish'
  | 'daily'
  | 'manual'
  | 'pre-restore'
  | 'pre-reset'
  | 'pre-migrate';

export const BACKUP_RE =
  /^(publish|daily|manual|pre-restore|pre-reset|pre-migrate)-(.*)-(\d{13})\.sqlite$/;
const TRASH_RE = /^(\d{13})-(.+)$/;

function slug(text: string): string {
  return (
    text
      .replace(/[^\w-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'db'
  );
}

/** The one spelling of a backup's file name; `BACKUP_RE` reads it back. */
export function backupFileName(kind: BackupKind, label: string, createdAt: number): string {
  return `${kind}-${slug(label)}-${createdAt}.sqlite`;
}

/**
 * Whether today's daily copy is still to take. "Today" is the manager's local date, the one on
 * the clock on the ward wall: a UTC date would roll over at 5 pm in California and take the
 * evening's copy as tomorrow's.
 */
export function dailyBackupDue(backups: readonly BackupInfo[], now: Date): boolean {
  const day = today(now);
  return !backups.some((b) => b.kind === 'daily' && today(new Date(b.createdAt)) === day);
}

/**
 * Swap the live database file for `source` (restore) or remove it (start over). The caller has
 * closed the connection. The source is copied next to the live file first and renamed over it,
 * so a copy that fails part way — a full disk, a backup that vanished — leaves the live file and
 * its WAL as they were. The WAL and shm files belong to the outgoing database: left behind they
 * would be replayed over the restored file (or a fresh one) on the next open.
 */
export function replaceDatabaseFile(live: string, source: string | undefined): void {
  const staged = `${live}.restoring`;
  if (source !== undefined) copyFileSync(source, staged);
  for (const suffix of ['-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true });
  if (source === undefined) rmSync(live, { force: true });
  else renameSync(staged, live);
}

function trashDir(dir: string): string {
  return join(dir, 'trash');
}

/** `path` defaults to the file itself; a trashed backup passes its `<deletedAt>-` name. */
function parse(dir: string, fileName: string, path = join(dir, fileName)): BackupInfo | undefined {
  const m = BACKUP_RE.exec(fileName);
  if (!m) return undefined;
  return { fileName, path, kind: m[1]!, createdAt: Number(m[3]), bytes: statSync(path).size };
}

function parseTrashed(dir: string, trashName: string): DeletedBackupInfo | undefined {
  const m = TRASH_RE.exec(trashName);
  if (!m) return undefined;
  const backup = parse(dir, m[2]!, join(dir, trashName));
  if (!backup) return undefined;
  const deletedAt = Number(m[1]);
  return {
    ...backup,
    deletedAt,
    purgeAt: deletedAt + TRASH_RETENTION_DAYS * DAY_MS,
  };
}

/** One live backup by name; undefined when the name is not a backup's. */
export function readBackup(dir: string, fileName: string): BackupInfo | undefined {
  return parse(dir, fileName);
}

/** Live backups in `dir`, newest first. */
export function listBackupFiles(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => parse(dir, name))
    .filter((b): b is BackupInfo => b !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Deleted backups awaiting purge, most recently deleted first. */
export function listTrash(dir: string): DeletedBackupInfo[] {
  const trash = trashDir(dir);
  if (!existsSync(trash)) return [];
  return readdirSync(trash)
    .map((name) => parseTrashed(trash, name))
    .filter((b): b is DeletedBackupInfo => b !== undefined)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Looks the name up in the listing rather than joining it onto the folder: an IPC caller's
 * `../live.sqlite` must never reach a rename.
 */
export function requireLive(dir: string, fileName: string): BackupInfo {
  const found = listBackupFiles(dir).find((b) => b.fileName === fileName);
  if (!found) throw new Error(`Unknown backup ${fileName}`);
  return found;
}

export function requireTrashed(dir: string, fileName: string): DeletedBackupInfo {
  const found = listTrash(dir).find((b) => b.fileName === fileName);
  if (!found) throw new Error(`Backup ${fileName} is not in the trash`);
  return found;
}

export function moveToTrash(dir: string, fileName: string, now: number): DeletedBackupInfo {
  const live = requireLive(dir, fileName);
  const trash = trashDir(dir);
  mkdirSync(trash, { recursive: true });
  const trashName = `${now}-${fileName}`;
  renameSync(live.path, join(trash, trashName));
  return parseTrashed(trash, trashName)!;
}

export function restoreFromTrash(dir: string, fileName: string): BackupInfo {
  const trashed = requireTrashed(dir, fileName);
  const target = join(dir, fileName);
  if (existsSync(target)) throw new Error(`A backup named ${fileName} already exists`);
  renameSync(trashed.path, target);
  return parse(dir, fileName)!;
}

export function purgeFromTrash(dir: string, fileName: string): DeletedBackupInfo {
  const trashed = requireTrashed(dir, fileName);
  rmSync(trashed.path, { force: true });
  return trashed;
}

/** Delete a live backup outright, skipping the trash. */
export function deleteLiveBackup(dir: string, fileName: string): BackupInfo {
  const live = requireLive(dir, fileName);
  rmSync(live.path, { force: true });
  return live;
}

/** Remove every trashed backup whose retention has run out; returns what went. */
export function purgeExpired(dir: string, now: number): DeletedBackupInfo[] {
  const expired = listTrash(dir).filter((b) => b.purgeAt <= now);
  for (const b of expired) rmSync(b.path, { force: true });
  return expired;
}

/** A backup is written under this suffix and renamed once verified, so a crash never leaves a half file under a real name. */
export const PARTIAL_SUFFIX = '.partial';

/**
 * Remove backups a crash or full disk left half-written. Only `<backup>.sqlite.partial` names
 * go: anything else in the folder is not ours to delete. Run at startup, before any backup of
 * this run could be in flight.
 */
export function removeStalePartials(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const stale = readdirSync(dir).filter((name) => name.endsWith(`.sqlite${PARTIAL_SUFFIX}`));
  for (const name of stale) rmSync(join(dir, name), { force: true });
  return stale;
}

export type DatabaseVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'not-sqlite' | 'damaged' | 'newer'; detail: string };

/**
 * Whether `path` is a database this build can open: a real SQLite file, internally consistent,
 * and not migrated by a newer release. A header check alone passed a truncated copy, and a
 * restored newer-schema file made the app refuse to start. Opened read-only so verifying can
 * never change the file; the handle is always closed.
 */
export function verifyDatabaseFile(path: string, migrationsFolder: string): DatabaseVerdict {
  if (!existsSync(path)) return { ok: false, reason: 'missing', detail: `${path} does not exist` };
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    const rows = sqlite.pragma('quick_check') as { quick_check: string }[];
    if (rows.length !== 1 || rows[0]!.quick_check !== 'ok') {
      return {
        ok: false,
        reason: 'damaged',
        detail: rows.map((r) => r.quick_check).join('; ') || 'quick_check returned nothing',
      };
    }
    if (migrationStatus(sqlite, migrationsFolder).newerThanApp) {
      return { ok: false, reason: 'newer', detail: 'migrated by a newer release' };
    }
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // SQLITE_NOTADB is a file that is not a database at all; anything else that fails while
    // reading it (a truncated page, a bad schema) is damage.
    const notDb =
      /not a database/i.test(detail) || (err as { code?: string }).code === 'SQLITE_NOTADB';
    return { ok: false, reason: notDb ? 'not-sqlite' : 'damaged', detail };
  } finally {
    sqlite?.close();
  }
}

/** What a manager is told when a backup cannot be restored; undefined when it can. Reaches the UI verbatim. */
export function restoreRefusal(verdict: DatabaseVerdict): string | undefined {
  if (verdict.ok) return undefined;
  switch (verdict.reason) {
    case 'newer':
      return 'This backup was made by a newer version of ShiftNurse. Update the app, then restore it.';
    case 'missing':
      return 'This backup file is no longer on disk.';
    default:
      return 'This backup file is damaged and cannot be restored. Choose another backup.';
  }
}

/**
 * Left next to the live database by a restore and consumed on the next open: the audit row
 * must be written into the *restored* database, which does not exist until the swap is done.
 */
export interface RestoreMarker {
  fileName: string;
  restoredFrom: string;
  savedAs: string;
  at: number;
}

const MARKER_FILE = 'restore-pending.json';

export function writeRestoreMarker(dir: string, marker: RestoreMarker): void {
  writeFileSync(join(dir, MARKER_FILE), JSON.stringify(marker));
}

/** Undefined when there is no marker or it is unreadable: a bad marker must not stop the app starting. */
export function readRestoreMarker(dir: string): RestoreMarker | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8')) as Partial<RestoreMarker>;
    if (
      typeof m.fileName !== 'string' ||
      typeof m.restoredFrom !== 'string' ||
      typeof m.savedAs !== 'string' ||
      typeof m.at !== 'number'
    ) {
      return undefined;
    }
    return { fileName: m.fileName, restoredFrom: m.restoredFrom, savedAs: m.savedAs, at: m.at };
  } catch {
    return undefined;
  }
}

export function clearRestoreMarker(dir: string): void {
  rmSync(join(dir, MARKER_FILE), { force: true });
}
