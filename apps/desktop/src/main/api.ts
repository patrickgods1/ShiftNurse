/**
 * The main-process implementation of the IPC contract: the wiring table.
 *
 * Each resource is built by a domain module under `api/` — no SQL here, no business logic
 * either. Anything that needs the rule engine or the solver goes into `packages/core` and is
 * called with data loaded by the repositories; that keeps the future HTTP server implementation
 * of the same contract a copy of this wiring rather than a rewrite. Every write runs in one
 * transaction with its audit row, inside those modules.
 *
 * Electron stays at the edges: this file (app info, logs, backups, the file dialogs from
 * `api/files.ts` merged into the resources that need them) and `api/publish.ts` (the
 * post-publish backup). The other `api/` modules run under plain Node and are tested that way.
 */

import { is } from '@electron-toolkit/utils';
import type { ShiftNurseDb } from '@shiftnurse/db';
import { app } from 'electron';
import type { ShiftNurseApi, UpdateInfo } from '../shared/api.js';
import { configApi } from './api/config.js';
import { costApi } from './api/cost.js';
import { dashboardSummary } from './api/dashboard.js';
import { dayOfApi } from './api/dayof.js';
import { censusApi } from './api/demand.js';
import { fairnessApi } from './api/fairness.js';
import { exportRosterToFile, pickHistoryImportFile, pickRosterImportFile } from './api/files.js';
import { overtimeVolunteersApi } from './api/overtime-volunteers.js';
import { outputInput, publishApi } from './api/publish.js';
import { requestsApi } from './api/requests.js';
import { rosterApi } from './api/roster.js';
import { periodsApi, scheduleApi } from './api/schedule.js';
import { setupApi } from './api/setup.js';
import { solverApi } from './api/solver.js';
import {
  createBackup,
  deleteBackup,
  listBackups,
  listDeletedBackups,
  purgeDeletedBackup,
  resetDatabase,
  restoreBackup,
  undeleteBackup,
} from './backups.js';
import { databasePath } from './database.js';
import { exportToFile as exportPeriodToFile, renderCsv } from './output.js';
import type { SolverJobs } from './solver-jobs.js';

export { outputInput } from './api/publish.js';
export { createSolverJobs } from './api/solver.js';

/** What the shell around the API knows that the database does not. */
export interface AppHost {
  /** The launch update check's finding, once it has one. */
  update(): UpdateInfo | undefined;
  openLogs(): void;
}

export function createApi(db: ShiftNurseDb, solverJobs: SolverJobs, host: AppHost): ShiftNurseApi {
  const roster = rosterApi(db);
  return {
    app: {
      info: () => ({
        version: app.getVersion(),
        platform: process.platform,
        databasePath: databasePath(),
      }),
      update: () => host.update() ?? null,
      openLogs: () => host.openLogs(),
    },
    ...configApi(db),
    setup: setupApi(db, {
      startOver: () => resetDatabase(db, () => solverJobs.dispose()),
      // Only under the electron-vite dev server (`npm run dev`): not in a built or packaged app.
      scenariosAvailable: is.dev && process.env.ELECTRON_RENDERER_URL !== undefined,
    }),
    dashboard: {
      summary: (unitId) => dashboardSummary(db, unitId),
    },
    ...roster,
    overtimeVolunteers: overtimeVolunteersApi(db),
    roster: {
      ...roster.roster,
      pickImportFile: (unitId) => pickRosterImportFile(db, unitId),
      exportToFile: (unitId) => exportRosterToFile(db, unitId),
    },
    census: censusApi(db),
    periods: periodsApi(db),
    schedule: scheduleApi(db),
    publish: publishApi(db),
    output: {
      exportToFile: (periodId, format) => exportPeriodToFile(outputInput(db, periodId), format),
      renderCsv: (periodId, format) => renderCsv(outputInput(db, periodId).schedule, format),
    },
    backups: {
      list: () => listBackups(),
      create: () => createBackup(db, 'manual', 'manual'),
      restore: (fileName) => restoreBackup(db, fileName, () => solverJobs.dispose()),
      listDeleted: () => listDeletedBackups(),
      remove: (fileName, options) => deleteBackup(db, fileName, options),
      undelete: (fileName) => undeleteBackup(db, fileName),
      purge: (fileName) => purgeDeletedBackup(db, fileName),
    },
    solver: solverApi(db, solverJobs),
    fairness: {
      ...fairnessApi(db),
      pickHistoryImportFile: (unitId) => pickHistoryImportFile(db, unitId),
    },
    cost: costApi(db),
    ...requestsApi(db),
    dayOf: dayOfApi(db),
  };
}
