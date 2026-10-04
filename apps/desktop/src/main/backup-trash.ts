/**
 * Deleting, restoring and purging backups, with their audit rows: the database half of the
 * trash that `backup-files.ts` keeps on disk.
 *
 * Every function takes the backup folder and (where time matters) the clock, and nothing here
 * imports Electron, so the audit trail is tested against a real database and a temp folder
 * (`backup-trash.test.ts`); `backups.ts` passes the real `userData` folder. Each audit row is
 * written after its file operation succeeds (a delete that failed must never be on the record
 * as done), and a failed audit puts the file back (a file that moved with no record is the gap
 * the audit rule exists to close).
 */

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { auditHistoryFor, recordAudit, type ShiftNurseDb, transact } from '@shiftnurse/db';
import type { BackupInfo, DeletedBackupInfo } from '../shared/api.js';
import {
  listTrash,
  moveToTrash,
  PURGING_SUFFIX,
  requireLive,
  requireTrashed,
  restoreFromTrash,
} from './backup-files.js';

/** Actor for audit rows written by the backup job itself. */
const ACTOR = 'manager';

/**
 * Run `audit` once `undo` is the only thing standing between a failed audit and a file that has
 * moved with no record. A reversible file operation is done first by the caller; if the audit
 * throws, the file goes back and the error still reaches the manager.
 */
function auditOrUndo(undo: () => void, audit: () => void): void {
  try {
    audit();
  } catch (err) {
    undo();
    throw err;
  }
}

/**
 * Remove a file for good, audited. Removal cannot be reversed, so the file is first renamed aside
 * (a name no listing recognises) and only deleted once the audit row is in: a failed audit puts
 * it back untouched.
 */
function removeAudited(path: string, audit: () => void): void {
  const aside = `${path}${PURGING_SUFFIX}`;
  renameSync(path, aside);
  auditOrUndo(() => renameSync(aside, path), audit);
  rmSync(aside, { force: true });
}

/**
 * Delete a backup. By default it goes to the trash for `TRASH_RETENTION_DAYS`; `permanent` is
 * the manager's override and removes the file now.
 */
export function deleteBackupIn(
  db: ShiftNurseDb,
  dir: string,
  fileName: string,
  options: { permanent?: boolean },
  now: number,
): BackupInfo {
  if (options.permanent) {
    const gone = requireLive(dir, fileName);
    removeAudited(gone.path, () => auditDelete(db, gone, { permanent: true }));
    return gone;
  }
  const live = requireLive(dir, fileName);
  const trashed = moveToTrash(dir, fileName, now);
  auditOrUndo(
    () => renameSync(trashed.path, live.path),
    () => auditDelete(db, trashed, { permanent: false, purgeAt: trashed.purgeAt }),
  );
  return trashed;
}

/** Take a backup back out of the trash onto the list. */
export function undeleteBackupIn(db: ShiftNurseDb, dir: string, fileName: string): BackupInfo {
  const trashed = requireTrashed(dir, fileName);
  const restored = restoreFromTrash(dir, fileName);
  auditOrUndo(
    () => renameSync(restored.path, trashed.path),
    () =>
      transact(db, (tx) =>
        recordAudit(tx, {
          entityType: 'backup',
          entityId: fileName,
          action: 'update',
          actor: ACTOR,
          before: { inTrash: true },
          after: { inTrash: false, path: restored.path },
        }),
      ),
  );
  return restored;
}

/** Delete a trashed backup now instead of waiting out its retention. */
export function purgeDeletedBackupIn(db: ShiftNurseDb, dir: string, fileName: string): void {
  const gone = requireTrashed(dir, fileName);
  removeAudited(gone.path, () => auditDelete(db, gone, { permanent: true }));
}

/** The launch sweep: trashed backups past their retention are removed for good. */
export function purgeExpiredBackupsIn(
  db: ShiftNurseDb,
  dir: string,
  now: number,
): DeletedBackupInfo[] {
  const expired = listTrash(dir).filter((b) => b.purgeAt <= now);
  // One at a time: a file whose audit failed stays in the trash for the next launch, and the
  // ones already removed keep their rows.
  for (const b of expired) {
    removeAudited(b.path, () => auditDelete(db, b, { permanent: true, expired: true }));
  }
  return expired;
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

/**
 * Finish what a crash interrupted. A permanent removal sits at `<name>.purging` between its
 * rename and its delete; if the audit row made it in, the removal was recorded and the file goes,
 * otherwise nothing was recorded and the backup is put back, never deleted unrecorded. Run at
 * startup, before any removal of this run could be in flight.
 */
export function settleInterruptedRemovals(db: ShiftNurseDb, dir: string): void {
  for (const folder of [dir, join(dir, 'trash')]) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(PURGING_SUFFIX)) continue;
      const original = name.slice(0, -PURGING_SUFFIX.length);
      // A trashed file's name carries `<deletedAt>-`; the audit row is keyed on the backup's own.
      const backupName = folder === dir ? original : original.replace(/^\d{13}-/, '');
      const recorded = auditHistoryFor(db, 'backup', backupName).some(
        (e) => e.action === 'delete' && (e.after as { permanent?: boolean } | null)?.permanent,
      );
      if (recorded) rmSync(join(folder, name), { force: true });
      else renameSync(join(folder, name), join(folder, original));
    }
  }
}
