/**
 * Owns the one database connection the application has.
 *
 * The file lives in Electron's `userData` directory — the per-user, per-app location the OS
 * expects application state in, which survives reinstalls and is what a backup job or a
 * support request will be pointed at. On first launch the file is empty, so the demo unit
 * is seeded: a manager evaluating the product should see a real roster and six months of
 * history, not an empty grid, and the seed is deterministic so two evaluators see the same
 * thing.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  listUnits,
  type OpenedDatabase,
  openDatabase,
  type ShiftNurseDb,
  seedDemoUnit,
  transact,
} from '@shiftnurse/db';
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

export function openAppDatabase(): ShiftNurseDb {
  if (opened) return opened.db;
  opened = openDatabase({ url: databasePath(), migrationsFolder: resolveMigrationsFolder() });

  if (listUnits(opened.db).length === 0) {
    const db = opened.db;
    const result = transact(db, (tx) => seedDemoUnit(tx));
    console.log(`[db] seeded demo unit ${result.unitId} into ${databasePath()}`);
  }
  return opened.db;
}

export function closeAppDatabase(): void {
  opened?.close();
  opened = undefined;
}
