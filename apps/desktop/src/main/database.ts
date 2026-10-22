/**
 * Owns the one database connection the application has.
 *
 * The file lives in Electron's `userData` directory — the per-user, per-app location the OS
 * expects application state in, which survives reinstalls and is what a backup job or a
 * support request will be pointed at. On Windows that is the Roaming profile; a redirected one
 * is detected and named (`data-location.ts`, D24), not moved. Opening only migrates: an empty
 * file is left empty, and the renderer's first-run welcome screen decides what goes in it (the
 * demo unit, a bare unit, or the assisted guide — see `api/setup.ts`). Seeding here would put a
 * fictional 42-nurse unit into every real install.
 */

import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  backfillDemandConfigVersions,
  backfillPayConfigSnapshots,
  DatabaseNewerThanAppError,
  type MigrationStatus,
  migrateDatabase,
  migrationStatus,
  type OpenedDatabase,
  openDatabase,
  recordAudit,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import { app } from 'electron';
import { clearRestoreMarker, readRestoreMarker, STAGED_SUFFIX } from './backup-files.js';

let opened: OpenedDatabase | undefined;

export function databasePath(): string {
  return join(app.getPath('userData'), 'shiftnurse.sqlite');
}

/**
 * `@shiftnurse/db` is bundled into this process (see electron.vite.config.ts), which moves
 * its `import.meta.url` and breaks its own default of "`drizzle/` next to my dist". So the
 * host locates the migrations: from the package's real install location in development, or
 * from the copy electron-builder places under `resources/` in a packaged build.
 */
export function resolveMigrationsFolder(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'drizzle');
  const require = createRequire(import.meta.url);
  const dbEntry = require.resolve('@shiftnurse/db'); // .../packages/db/dist/index.js
  return join(dirname(dbEntry), '..', 'drizzle');
}

export function getDb(): ShiftNurseDb {
  if (!opened) throw new Error('Database not opened; call openAppDatabase() during app ready');
  return opened.db;
}

/** The raw driver handle, for the online backup API. */
export function getSqlite(): OpenedDatabase['sqlite'] {
  if (!opened) throw new Error('Database not opened; call openAppDatabase() during app ready');
  return opened.sqlite;
}

/**
 * Open the database, letting the host copy it before an update migrates it. Opening without
 * migrating first is what makes that copy possible: the migrator would otherwise have changed
 * the file before anyone could save the old one. A database from a newer release is refused
 * before anything touches it.
 */
export async function openAppDatabase(
  beforeMigrate: (sqlite: OpenedDatabase['sqlite'], status: MigrationStatus) => Promise<void>,
): Promise<ShiftNurseDb> {
  if (opened) return opened.db;
  const folder = resolveMigrationsFolder();
  const candidate = openDatabase({ url: databasePath(), migrateOnOpen: false });
  try {
    const status = migrationStatus(candidate.sqlite, folder);
    if (status.newerThanApp) throw new DatabaseNewerThanAppError();
    if (status.pending > 0) {
      await beforeMigrate(candidate.sqlite, status);
      migrateDatabase(candidate.db, folder);
    }
  } catch (err) {
    candidate.close();
    throw err;
  }
  opened = candidate;
  recordPendingRestore(candidate.db);
  recordEarlierPayConfigs(candidate.db);
  recordMissedDemandVersions(candidate.db);
  return opened.db;
}

/**
 * Keep the pay settings of any published schedule that has none: the first launch after
 * snapshots were introduced, or a restored older backup. Those are priced live until now, so this
 * changes no figure; it stops later edits from repricing them. Writes only when one is missing,
 * and like `recordPendingRestore` never blocks startup.
 */
function recordEarlierPayConfigs(db: ShiftNurseDb): void {
  try {
    transact(db, (tx) => backfillPayConfigSnapshots(tx, 'manager'));
  } catch (err) {
    console.error(`[pay] could not record the pay settings of earlier schedules: ${err}`);
  }
}

/**
 * Record the demand rules (ratios, tiers, floors, ratio staffing, active shift types) of any unit
 * whose change was saved without its version, and a first version for a unit with none: the first
 * launch after versions were kept, or a restored older backup. Today's verdicts are unchanged; it
 * stops a later edit from rewriting how past dates are judged. Never blocks startup.
 */
function recordMissedDemandVersions(db: ShiftNurseDb): void {
  try {
    transact(db, (tx) => backfillDemandConfigVersions(tx, 'manager'));
  } catch (err) {
    console.error(`[demand] could not record the demand rules of earlier changes: ${err}`);
  }
}

/**
 * A restore swaps the file, so its audit row can only be written once the restored database is
 * open. The marker is removed only after the row commits: a crash in between audits it on the
 * next launch rather than losing it. Never blocks startup.
 *
 * The marker is written just before the staged backup is renamed over the live file, so a crash
 * in that gap leaves both. A successful rename consumes the staged file, so finding it proves the
 * swap never happened: this is the database the manager had, and auditing a restore into it
 * would record one that did not take place.
 */
function recordPendingRestore(db: ShiftNurseDb): void {
  const dir = dirname(databasePath());
  const staged = `${databasePath()}${STAGED_SUFFIX}`;
  if (existsSync(staged)) {
    try {
      rmSync(staged, { force: true });
    } catch (err) {
      console.error('[backup] could not remove the staged backup:', err);
    }
    try {
      clearRestoreMarker(dir);
    } catch (err) {
      console.error('[backup] could not remove the restore marker:', err);
    }
    console.error(
      '[backup] a restore was interrupted before the backup was swapped in; the database was not changed and no restore is recorded',
    );
    return;
  }
  const marker = readRestoreMarker(dir);
  if (!marker) return;
  try {
    transact(db, (tx) =>
      recordAudit(tx, {
        entityType: 'backup',
        entityId: marker.fileName,
        action: 'restore',
        actor: 'manager',
        before: { savedAs: marker.savedAs },
        after: { restoredFrom: marker.restoredFrom },
        at: marker.at,
      }),
    );
    clearRestoreMarker(dir);
  } catch (err) {
    console.error(`[backup] could not record the restore in the audit log: ${err}`);
  }
}

export function closeAppDatabase(): void {
  opened?.close();
  opened = undefined;
}
