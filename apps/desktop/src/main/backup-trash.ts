/**
 * Deleting, restoring and purging backups, with their audit rows: the database half of the
 * trash that `backup-files.ts` keeps on disk.
 *
 * Every function takes the backup folder and (where time matters) the clock, and nothing here
 * imports Electron, so the audit trail is tested against a real database and a temp folder
 * (`backup-trash.test.ts`); `backups.ts` passes the real `userData` folder. Each audit row is
 * written after its file operation succeeds: a delete that failed must never be on the record
 * as done.
 */

import { recordAudit, type ShiftNurseDb, transact } from '@shiftnurse/db';
import type { BackupInfo, DeletedBackupInfo } from '../shared/api.js';
import {
  deleteLiveBackup,
  moveToTrash,
  purgeExpired,
  purgeFromTrash,
  restoreFromTrash,
} from './backup-files.js';

/** Actor for audit rows written by the backup job itself. */
const ACTOR = 'manager';

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
    const gone = deleteLiveBackup(dir, fileName);
    auditDelete(db, gone, { permanent: true });
    return gone;
  }
  const trashed = moveToTrash(dir, fileName, now);
  auditDelete(db, trashed, { permanent: false, purgeAt: trashed.purgeAt });
  return trashed;
}

/** Take a backup back out of the trash onto the list. */
export function undeleteBackupIn(db: ShiftNurseDb, dir: string, fileName: string): BackupInfo {
  const restored = restoreFromTrash(dir, fileName);
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
export function purgeDeletedBackupIn(db: ShiftNurseDb, dir: string, fileName: string): void {
  const gone = purgeFromTrash(dir, fileName);
  auditDelete(db, gone, { permanent: true });
}

/** The launch sweep: trashed backups past their retention are removed for good. */
export function purgeExpiredBackupsIn(
  db: ShiftNurseDb,
  dir: string,
  now: number,
): DeletedBackupInfo[] {
  const purged = purgeExpired(dir, now);
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
