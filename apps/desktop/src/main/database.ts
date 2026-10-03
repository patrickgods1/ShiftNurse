/**
 * Owns the one database connection the application has.
 *
 * The file lives in Electron's `userData` directory — the per-user, per-app location the OS
 * expects application state in, which survives reinstalls and is what a backup job or a
 * support request will be pointed at. Opening only migrates: an empty file is left empty, and
 * the renderer's first-run welcome screen decides what goes in it (the demo unit, a bare unit,
 * or the assisted guide — see `api/setup.ts`). Seeding here would put a fictional 42-nurse
 * unit into every real install.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
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
import { clearRestoreMarker, readRestoreMarker } from './backup-files.js';

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
  return opened.db;
}

/**
 * A restore swaps the file, so its audit row can only be written once the restored database is
 * open. The marker is removed only after the row commits: a crash in between audits it on the
 * next launch rather than losing it. Never blocks startup.
 */
function recordPendingRestore(db: ShiftNurseDb): void {
  const dir = dirname(databasePath());
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
