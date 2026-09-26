/**
 * The main-process implementation of the IPC contract: the wiring table.
 *
 * Each method is a thin composition of repository functions and the domain modules under
 * `api/` — no SQL here, no business logic either. Anything that needs the rule engine or the
 * solver goes into `packages/core` and is called with data loaded by the repositories; that
 * keeps the future HTTP server implementation of the same contract a copy of this wiring rather
 * than a rewrite. Electron stays at the edges: this file (app info), `api/files.ts` (dialogs) and
 * `api/publish.ts` (the post-publish backup). The other `api/` modules run under plain Node and
 * are tested that way.
 */

import {
  addDays,
  backtest,
  datesInRange,
  deriveDemand,
  evaluateExchange,
  formatRosterCsv,
  type Preference,
  proposeCensus,
  timeOffImpact,
  today,
} from '@shiftnurse/core';
import {
  applyResolution,
  approveTimeOffAndLiftAssignments,
  cancelSwap,
  cancelTimeOff,
  createAcuityTier,
  createCredential,
  createDifferential,
  createHoliday,
  createNurse,
  createOvertimeRule,
  createPayRate,
  createRatioRule,
  createShiftType,
  createTimeOffRequest,
  deactivateNurse,
  deactivateRatioRule,
  deactivateShiftType,
  deleteAcuityTier,
  deleteCensusForecast,
  deleteCoverageRequirement,
  deleteDifferential,
  deleteHoliday,
  deleteOvertimeRule,
  deletePayRate,
  demandInputs,
  denySwap,
  denyTimeOff,
  exportRoster,
  getConflictPolicy,
  getHppdTarget,
  getNurse,
  getSolverSettings,
  grantCredential,
  ids,
  importRoster,
  LEDGER_LOOKBACK_DAYS,
  ledgerSince,
  listAcuityTiersForUnit,
  listCensusForecastsInRange,
  listCensusHistory,
  listChanges,
  listCoverageRequirementsForUnit,
  listCredentials,
  listDifferentialsForUnit,
  listHolidaysForUnit,
  listNurseCredentials,
  listNursesForUnit,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
  listPreferencesForNurse,
  listRatioRulesForUnit,
  listShiftTypesForUnit,
  listSwapsForPeriod,
  listSwapsForUnit,
  listTimeOffForUnit,
  listTimeOffOverlappingForUnit,
  listUnits,
  listVersions,
  proposeSwap,
  recordActualCensus,
  replaceNursePreferences,
  revokeCredential,
  type ShiftNurseDb,
  saveConflictPolicy,
  saveRuleSet,
  saveSolverSettings,
  transact,
  updateAcuityTier,
  updateCredentialExpiry,
  updateDifferential,
  updateNurse,
  updateOvertimeRule,
  updatePayRate,
  updateRatioRule,
  updateShiftType,
  upsertCensusForecast,
  upsertCensusForecasts,
  upsertCoverageRequirement,
  upsertHppdTarget,
  withdrawApproval,
} from '@shiftnurse/db';
import { app } from 'electron';
import type { ShiftNurseApi } from '../shared/api.js';
import { analyse, approveExchange, autoResolve } from './api/conflicts.js';
import { ACTOR, buildConflictInput, latestRuleSetOrDefault } from './api/context.js';
import { costReport, setPeriodBudget } from './api/cost.js';
import { dashboardSummary } from './api/dashboard.js';
import { dayOfApi } from './api/dayof.js';
import { fairnessReport, fairnessTrend, importHistory } from './api/fairness.js';
import { exportRosterToFile, pickHistoryImportFile, pickRosterImportFile } from './api/files.js';
import { alertsFor, outputInput, publish, publishPreview } from './api/publish.js';
import { periodsApi, scheduleApi } from './api/schedule.js';
import { createSolverJobs } from './api/solver.js';
import { createBackup, listBackups, restoreBackup } from './backups.js';
import { databasePath } from './database.js';
import { exportToFile as exportPeriodToFile, renderCsv } from './output.js';
import { cpsatRunnerPath, ORTOOLS_BACKEND_IDS } from './solver-backends.js';
import { solverAvailability } from './solver-choice.js';
import type { SolverJobs } from './solver-jobs.js';

export { outputInput } from './api/publish.js';
export { createSolverJobs } from './api/solver.js';

export function createApi(
  db: ShiftNurseDb,
  solverJobs: SolverJobs = createSolverJobs(db),
): ShiftNurseApi {
  return {
    app: {
      info: () => ({
        version: app.getVersion(),
        platform: process.platform,
        databasePath: databasePath(),
      }),
    },
    units: {
      list: () => listUnits(db),
    },
    dashboard: {
      summary: (unitId) => dashboardSummary(db, unitId),
    },
    nurses: {
      list: (unitId) => listNursesForUnit(db, unitId),
      get: (id) => getNurse(db, id),
      create: (input) => createNurse(db, input, ACTOR),
      update: (id, patch) => updateNurse(db, id, patch, ACTOR),
      deactivate: (id) => deactivateNurse(db, id, ACTOR),
    },
    credentials: {
      list: () => listCredentials(db),
      create: (input) => createCredential(db, input, ACTOR),
      forNurse: (nurseId) => listNurseCredentials(db, nurseId),
      grant: (input) => grantCredential(db, input, ACTOR),
      updateExpiry: (id, expiresOn) => updateCredentialExpiry(db, id, expiresOn, ACTOR),
      revoke: (id) => revokeCredential(db, id, ACTOR),
    },
    preferences: {
      forNurse: (nurseId) => listPreferencesForNurse(db, nurseId),
      replace: (nurseId, inputs) =>
        replaceNursePreferences(
          db,
          nurseId,
          inputs.map((p) => ({ ...p, id: ids.preference(), nurseId }) as Preference),
          ACTOR,
        ),
    },
    shiftTypes: {
      list: (unitId) => listShiftTypesForUnit(db, unitId),
      create: (input) => createShiftType(db, input, ACTOR),
      update: (id, patch) => updateShiftType(db, id, patch, ACTOR),
      deactivate: (id) => deactivateShiftType(db, id, ACTOR),
    },
    coverage: {
      list: (unitId) => listCoverageRequirementsForUnit(db, unitId),
      upsert: (input) => upsertCoverageRequirement(db, input, ACTOR),
      delete: (id) => deleteCoverageRequirement(db, id, ACTOR),
    },
    holidays: {
      list: (unitId) => listHolidaysForUnit(db, unitId),
      create: (input) => createHoliday(db, input, ACTOR),
      delete: (id) => deleteHoliday(db, id, ACTOR),
    },
    acuity: {
      tiers: (unitId) => listAcuityTiersForUnit(db, unitId),
      createTier: (input) => createAcuityTier(db, input, ACTOR),
      updateTier: (id, patch) => updateAcuityTier(db, id, patch, ACTOR),
      deleteTier: (id) => deleteAcuityTier(db, id, ACTOR),
      ratioRules: (unitId) => listRatioRulesForUnit(db, unitId),
      createRatioRule: (input) => createRatioRule(db, input, ACTOR),
      updateRatioRule: (id, patch) => updateRatioRule(db, id, patch, ACTOR),
      deactivateRatioRule: (id) => deactivateRatioRule(db, id, ACTOR),
      hppd: (unitId) => getHppdTarget(db, unitId),
      setHppd: (unitId, targetHours) => upsertHppdTarget(db, unitId, targetHours, ACTOR),
    },
    census: {
      list: (unitId, start, end) => listCensusForecastsInRange(db, unitId, start, end),
      upsert: (input) => upsertCensusForecast(db, input, ACTOR),
      upsertMany: (inputs) => transact(db, (tx) => upsertCensusForecasts(tx, inputs, ACTOR)),
      recordActual: (id, actualCensus, actualAcuityMix) =>
        recordActualCensus(db, id, actualCensus, actualAcuityMix, ACTOR),
      delete: (id) => deleteCensusForecast(db, id, ACTOR),
      propose: (unitId, start, end, options) => {
        const shiftTypes = listShiftTypesForUnit(db, unitId).filter((s) => s.active && !s.isOnCall);
        const targets = datesInRange(start, end).flatMap((date) =>
          shiftTypes.map((s) => ({ date, shiftTypeId: s.id })),
        );
        return proposeCensus(listCensusHistory(db, unitId), targets, options);
      },
      backtest: (unitId, options) => backtest(listCensusHistory(db, unitId), options),
      demand: (unitId, start, end) =>
        deriveDemand(datesInRange(start, end), demandInputs(db, unitId, start, end)).all(),
    },
    roster: {
      pickImportFile: (unitId) => pickRosterImportFile(db, unitId),
      importRows: (unitId, rows) => transact(db, (tx) => importRoster(tx, unitId, rows, ACTOR)),
      exportToFile: (unitId) => exportRosterToFile(db, unitId),
      exportCsv: (unitId) => formatRosterCsv(exportRoster(db, unitId)),
    },
    periods: periodsApi(db),
    schedule: scheduleApi(db),
    publish: {
      preview: (periodId) => publishPreview(db, periodId),
      publish: (periodId, reason) => publish(db, periodId, reason),
      versions: (periodId) => listVersions(db, periodId),
      changes: (periodId) => listChanges(db, periodId),
      alerts: (periodId) => alertsFor(db, periodId),
    },
    output: {
      exportToFile: (periodId, format) => exportPeriodToFile(outputInput(db, periodId), format),
      renderCsv: (periodId, format) => renderCsv(outputInput(db, periodId).schedule, format),
    },
    backups: {
      list: () => listBackups(),
      create: () => createBackup(db, 'manual', 'manual'),
      restore: (fileName) => restoreBackup(db, fileName, () => solverJobs.dispose()),
    },
    solver: {
      start: (periodId, options) => solverJobs.start(periodId, options),
      status: (jobId) => solverJobs.status(jobId),
      cancel: (jobId) => solverJobs.cancel(jobId),
      available: () => solverAvailability(cpsatRunnerPath() !== undefined, ORTOOLS_BACKEND_IDS),
    },
    solverSettings: {
      get: (unitId) => getSolverSettings(db, unitId),
      save: (unitId, settings) => {
        const { id: _id, ...saved } = saveSolverSettings(db, unitId, settings, ACTOR);
        return saved;
      },
    },
    rules: {
      getLatest: (unitId) => latestRuleSetOrDefault(db, unitId),
      save: (unitId, name, configs, weekendDefinition, fairnessWeights) =>
        saveRuleSet(
          db,
          {
            ...latestRuleSetOrDefault(db, unitId),
            name,
            configs,
            weekendDefinition,
            fairnessWeights,
          },
          ACTOR,
        ),
    },
    fairness: {
      report: (periodId) => fairnessReport(db, periodId),
      history: (unitId) => ledgerSince(db, unitId, addDays(today(), -LEDGER_LOOKBACK_DAYS)),
      trend: (unitId) => fairnessTrend(db, unitId),
      pickHistoryImportFile: (unitId) => pickHistoryImportFile(db, unitId),
      importHistory: (unitId, rows) => importHistory(db, unitId, rows),
    },
    cost: {
      payRates: (unitId) => listPayRatesForUnit(db, unitId),
      createPayRate: (input) => createPayRate(db, input, ACTOR),
      updatePayRate: (id, patch) => updatePayRate(db, id, patch, ACTOR),
      deletePayRate: (id) => deletePayRate(db, id, ACTOR),
      differentials: (unitId) => listDifferentialsForUnit(db, unitId),
      createDifferential: (input) => createDifferential(db, input, ACTOR),
      updateDifferential: (id, patch) => updateDifferential(db, id, patch, ACTOR),
      deleteDifferential: (id) => deleteDifferential(db, id, ACTOR),
      overtimeRules: (unitId) => listOvertimeRulesForUnit(db, unitId),
      createOvertimeRule: (input) => createOvertimeRule(db, input, ACTOR),
      updateOvertimeRule: (id, patch) => updateOvertimeRule(db, id, patch, ACTOR),
      deleteOvertimeRule: (id) => deleteOvertimeRule(db, id, ACTOR),
      report: (periodId) => costReport(db, periodId),
      setBudget: (periodId, targetDollars) => setPeriodBudget(db, periodId, targetDollars),
    },
    timeOff: {
      list: (unitId, status) => listTimeOffForUnit(db, unitId, status),
      listInRange: (unitId, start, end) => listTimeOffOverlappingForUnit(db, unitId, start, end),
      create: (input) => createTimeOffRequest(db, input, ACTOR),
      approve: (id, reason) =>
        transact(db, (tx) => approveTimeOffAndLiftAssignments(tx, id, ACTOR, reason)),
      deny: (id, reason) => denyTimeOff(db, id, ACTOR, reason),
      cancel: (id, reason) => cancelTimeOff(db, id, ACTOR, reason),
      withdrawApproval: (id, reason) => withdrawApproval(db, id, ACTOR, reason),
      impact: (periodId, requestId, decision) =>
        timeOffImpact(buildConflictInput(db, periodId), requestId, decision),
    },
    conflicts: {
      analyse: (periodId) => analyse(db, periodId),
      policy: (unitId) => getConflictPolicy(db, unitId),
      savePolicy: (unitId, policy) => saveConflictPolicy(db, unitId, policy, ACTOR),
      resolve: (periodId, resolution, reason) =>
        transact(
          db,
          (tx) =>
            applyResolution(tx, periodId, resolution, ACTOR, { auto: false, reason }).resolution,
        ),
      autoResolve: (periodId) => autoResolve(db, periodId),
    },
    exchange: {
      list: (unitId, status) => listSwapsForUnit(db, unitId, status),
      listForPeriod: (periodId, status) => listSwapsForPeriod(db, periodId, status),
      evaluate: (periodId, proposal) =>
        evaluateExchange({ ...buildConflictInput(db, periodId), proposal }),
      propose: (periodId, proposal, reason) =>
        proposeSwap(db, { ...proposal, periodId, reason }, ACTOR),
      approve: (id, reason) => approveExchange(db, id, reason),
      deny: (id, reason) => denySwap(db, id, ACTOR, reason),
      cancel: (id, reason) => cancelSwap(db, id, ACTOR, reason),
    },
    dayOf: dayOfApi(db),
  };
}
