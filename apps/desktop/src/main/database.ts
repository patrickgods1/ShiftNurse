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
import { type OpenedDatabase, openDatabase, type ShiftNurseDb } from '@shiftnurse/db';
import { app } from 'electron';

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
function resolveMigrationsFolder(): string {
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

export function openAppDatabase(): ShiftNurseDb {
  if (opened) return opened.db;
  opened = openDatabase({ url: databasePath(), migrationsFolder: resolveMigrationsFolder() });
  return opened.db;
}

export function closeAppDatabase(): void {
  opened?.close();
  opened = undefined;
}
