/**
 * `@shiftnurse/db` — persistence for ShiftNurse.
 *
 * Owned exclusively by the Electron main process. The renderer never imports this package;
 * it reaches data through typed IPC, which is both a security boundary and the seam that
 * lets the renderer later talk to an HTTP API without changing.
 *
 * Repository functions all take `DbLike` as their first argument, so any of them can run
 * standalone or be composed inside a single `transact()` call. That is what lets a
 * multi-table operation — publishing a schedule writes assignments, a period status, a
 * fairness ledger and audit entries — reuse the individual functions and still be atomic.
 */

export type { AuditInput } from './audit.js';
export {
  auditHistoryFor,
  recentAudit,
  recordAudit,
  recordAuditStrict,
  requiresReason,
} from './audit.js';
export type {
  DbLike,
  MigrationStatus,
  OpenedDatabase,
  OpenOptions,
  ShiftNurseDb,
  ShiftNurseTx,
} from './client.js';
export {
  DatabaseNewerThanAppError,
  migrateDatabase,
  migrationStatus,
  migrationsFolder,
  openDatabase,
  openTestDatabase,
  transact,
} from './client.js';
export { ids, newId } from './ids.js';
export * as mappers from './mappers.js';
export * from './repositories/acuity.js';
export * from './repositories/calloffs.js';
export * from './repositories/census.js';
export * from './repositories/config.js';
export * from './repositories/conflicts.js';
export * from './repositories/exchange.js';
export * from './repositories/holidays.js';
export * from './repositories/incompatibility.js';
export * from './repositories/ledger.js';
export * from './repositories/pay.js';
export * from './repositories/publish.js';
export * from './repositories/roster.js';
export * from './repositories/roster-io.js';
export * from './repositories/rulesets.js';
export * from './repositories/schedule.js';
export * from './repositories/setup.js';
export * from './repositories/solve-input.js';
export * from './repositories/solver.js';
export * from './repositories/timeoff.js';
export * as schema from './schema.js';
export type { DemoId, DemoSummary } from './seed/demo.js';
export { DEFAULT_DEMO_ID, DEMO_SUMMARIES, isDemoId, seedDemoUnit } from './seed/demo.js';
export { seedScenarioUnit } from './seed/scenarios.js';
export type { SeedOptions, SeedResult } from './seed/types.js';
