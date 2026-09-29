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

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupInfo, DeletedBackupInfo } from '../shared/api.js';

export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export const BACKUP_RE = /^(publish|daily|manual|pre-restore|pre-reset)-(.*)-(\d{13})\.sqlite$/;
const TRASH_RE = /^(\d{13})-(.+)$/;

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
function requireLive(dir: string, fileName: string): BackupInfo {
  const found = listBackupFiles(dir).find((b) => b.fileName === fileName);
  if (!found) throw new Error(`Unknown backup ${fileName}`);
  return found;
}

function requireTrashed(dir: string, fileName: string): DeletedBackupInfo {
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
