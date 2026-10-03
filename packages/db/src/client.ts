/**
 * Database lifecycle: opening, configuring and migrating the SQLite file.
 *
 * The database is owned exclusively by the Electron main process. The renderer never sees a
 * connection — it goes through typed IPC, which is both a security boundary (no arbitrary SQL
 * from a web context) and the seam that lets the renderer later talk to an HTTP API instead.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema.js';

export type ShiftNurseDb = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenOptions {
  /** File path, or `:memory:` for tests. */
  url: string;
  /** Apply pending migrations on open. Default true. */
  migrateOnOpen?: boolean;
  /** Log every statement. Noisy; for debugging only. */
  verbose?: boolean;
  /**
   * Where the generated SQL migrations live. Defaults to this package's own `drizzle/`
   * folder, which is right whenever the package is loaded from its own location. A bundler
   * that inlines this module (the Electron main build does) relocates `import.meta.url`, so
   * the host passes the real path explicitly.
   */
  migrationsFolder?: string;
}

export interface OpenedDatabase {
  db: ShiftNurseDb;
  /** The raw driver handle, for backups, PRAGMA and VACUUM. */
  sqlite: Database.Database;
  close(): void;
}

/** Where the generated migrations live, resolved relative to this module at runtime. */
export function migrationsFolder(): string {
  // dist/client.js -> package root -> drizzle/
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'drizzle');
}

export function openDatabase(options: OpenOptions): OpenedDatabase {
  const { url, migrateOnOpen = true, verbose = false } = options;
  const migrations = options.migrationsFolder ?? migrationsFolder();

  if (url !== ':memory:') {
    const dir = dirname(url);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(url, verbose ? { verbose: console.log } : {});

  // WAL lets a long-running read (rendering a six-week grid) proceed while a write commits.
  // Not available for in-memory databases, where it is also pointless.
  if (url !== ':memory:') sqlite.pragma('journal_mode = WAL');
  // SQLite ships with foreign keys OFF. Without this, every `references()` in the schema is
  // documentation rather than a constraint, and orphaned assignments become possible.
  sqlite.pragma('foreign_keys = ON');
  // Wait rather than throwing SQLITE_BUSY if the backup job holds a lock.
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });

  if (migrateOnOpen) {
    try {
      migrateDatabase(db, migrations);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

/** Where a database stands against the migrations this build of the app ships. */
export interface MigrationStatus {
  /** No migration has ever run: a new, empty file. */
  fresh: boolean;
  /** Migrations this build will apply on open. */
  pending: number;
  /** The file was migrated by a newer build: this one does not know its schema. */
  newerThanApp: boolean;
}

/**
 * Thrown instead of opening a database written by a newer release. Drizzle's migrator would
 * see nothing to apply and carry on, and this build's queries would then run against tables
 * it has never seen — a restored backup from after an update, opened on a machine before it.
 */
export class DatabaseNewerThanAppError extends Error {
  constructor() {
    super(
      'This database was last opened by a newer version of ShiftNurse. Install the latest ' +
        'version to open it; this one does not know its layout and could damage it.',
    );
    this.name = 'DatabaseNewerThanAppError';
  }
}

const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * The same comparison drizzle's migrator makes (a migration runs when its folder timestamp is
 * later than the last applied one), done without writing anything, so the host can back the
 * file up before an upgrade touches it.
 */
export function migrationStatus(sqlite: Database.Database, folder: string): MigrationStatus {
  const bundled = readMigrationFiles({ migrationsFolder: folder });
  const hasTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  const last = hasTable
    ? (sqlite.prepare(`SELECT MAX(created_at) AS at FROM ${MIGRATIONS_TABLE}`).get() as {
        at: number | null;
      })
    : undefined;
  if (last?.at == null) return { fresh: true, pending: bundled.length, newerThanApp: false };
  const lastAt = Number(last.at);
  const newest = Math.max(0, ...bundled.map((m) => m.folderMillis));
  return {
    fresh: false,
    pending: bundled.filter((m) => m.folderMillis > lastAt).length,
    newerThanApp: lastAt > newest,
  };
}

/** Apply pending migrations, refusing a database a newer release has already migrated. */
export function migrateDatabase(db: ShiftNurseDb, folder: string): void {
  if (migrationStatus(db.$client, folder).newerThanApp) throw new DatabaseNewerThanAppError();
  migrate(db, { migrationsFolder: folder });
}

/**
 * Open an in-memory database with the schema applied. For tests.
 *
 * Migrations run from the same generated SQL the real database uses, so a test cannot pass
 * against a schema that drifted from the migrations.
 */
export function openTestDatabase(): OpenedDatabase {
  return openDatabase({ url: ':memory:', migrateOnOpen: true });
}

/**
 * A transaction handle. Structurally similar to `ShiftNurseDb` but not identical — it has no
 * `$client` and cannot itself be committed — so it gets its own type rather than a cast.
 */
export type ShiftNurseTx = Parameters<Parameters<ShiftNurseDb['transaction']>[0]>[0];

/**
 * Anything a repository can run queries against.
 *
 * Every repository function takes this rather than `ShiftNurseDb`, so the same function works
 * standalone or composed inside a larger transaction. That is what makes "publish a schedule"
 * — which writes assignments, a period status, a fairness ledger and audit entries — able to
 * reuse the individual repository functions and still be atomic.
 */
export type DbLike = ShiftNurseDb | ShiftNurseTx;

/**
 * Run `work` in a transaction, rolling back on any throw.
 *
 * Multi-table operations must be atomic: a partial publish is worse than a failed one.
 */
export function transact<T>(db: ShiftNurseDb, work: (tx: ShiftNurseTx) => T): T {
  return db.transaction(work);
}
