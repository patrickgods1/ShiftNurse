/**
 * The main-process implementation of the IPC contract.
 *
 * Each method is a thin composition of repository functions — no SQL here, no business
 * logic either. Anything that needs the rule engine or the solver goes into `packages/core`
 * and is called from here with data loaded by the repositories; that keeps the future HTTP
 * server implementation of the same contract a copy of this file rather than a rewrite.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  addDays,
  backtest,
  datesInRange,
  deriveDemand,
  formatRosterCsv,
  type Id,
  type IsoDate,
  type Preference,
  parseRosterCsv,
  proposeCensus,
  type SchedulePeriod,
  type ShiftType,
  today,
} from '@shiftnurse/core';
import {
  createAcuityTier,
  createCredential,
  createHoliday,
  createNurse,
  createRatioRule,
  createShiftType,
  credentialsExpiringBetween,
  deactivateNurse,
  deactivateRatioRule,
  deactivateShiftType,
  deleteAcuityTier,
  deleteCensusForecast,
  deleteCoverageRequirement,
  deleteHoliday,
  exportRoster,
  getCurrentDraft,
  getHppdTarget,
  getNurse,
  getNurseByEmployeeId,
  getUnit,
  grantCredential,
  ids,
  importRoster,
  listActiveNursesForUnit,
  listActiveRatioRulesForUnit,
  listAcuityTiersForUnit,
  listAssignmentsForDate,
  listAssignmentsForPeriod,
  listCensusForecastsInRange,
  listCensusHistory,
  listCoverageRequirementsForUnit,
  listCredentials,
  listHolidaysForUnit,
  listNurseCredentials,
  listNursesForUnit,
  listOpenCallOffs,
  listPeriodsForUnit,
  listPreferencesForNurse,
  listRatioRulesForUnit,
  listShiftTypesForUnit,
  listTimeOffForUnit,
  listUnits,
  recordActualCensus,
  replaceNursePreferences,
  revokeCredential,
  type ShiftNurseDb,
  transact,
  updateAcuityTier,
  updateCredentialExpiry,
  updateNurse,
  updateRatioRule,
  updateShiftType,
  upsertCensusForecast,
  upsertCensusForecasts,
  upsertCoverageRequirement,
  upsertHppdTarget,
} from '@shiftnurse/db';
import { app, BrowserWindow, dialog } from 'electron';
import type {
  DashboardSummary,
  OnShiftView,
  RosterImportPreview,
  ShiftNurseApi,
} from '../shared/api.js';
import { databasePath } from './database.js';

/**
 * v1 has one user, the manager, and no login. Every audit entry is attributed to this actor;
 * when accounts arrive this becomes the session's user and nothing else changes.
 */
const ACTOR = 'manager';

const CREDENTIAL_LOOKAHEAD_DAYS = 90;

function latestPublished(periods: SchedulePeriod[]): SchedulePeriod | undefined {
  return periods
    .filter((p) => p.status === 'published')
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
}

function onShiftToday(db: ShiftNurseDb, unitId: Id, date: IsoDate): OnShiftView[] {
  const nurses = new Map(listNursesForUnit(db, unitId).map((n) => [n.id, n]));
  const shiftTypes = listShiftTypesForUnit(db, unitId);
  const byShift = new Map<Id, OnShiftView>(
    shiftTypes.map((st: ShiftType) => [st.id, { shiftType: st, nurses: [] }]),
  );
  for (const a of listAssignmentsForDate(db, date)) {
    const view = byShift.get(a.shiftTypeId);
    const nurse = nurses.get(a.nurseId);
    if (view && nurse) view.nurses.push(nurse);
  }
  return [...byShift.values()].filter((v) => v.nurses.length > 0);
}

function dashboardSummary(db: ShiftNurseDb, unitId: Id): DashboardSummary {
  const unit = getUnit(db, unitId);
  if (!unit) throw new Error(`Unknown unit ${unitId}`);
  const now = today();
  const periods = listPeriodsForUnit(db, unitId);
  const unitNurseIds = new Set(listNursesForUnit(db, unitId).map((n) => n.id));

  return {
    unit,
    today: now,
    activeNurses: listActiveNursesForUnit(db, unitId).length,
    currentDraft: getCurrentDraft(db, unitId),
    latestPublished: latestPublished(periods),
    pendingTimeOff: listTimeOffForUnit(db, unitId, 'pending').length,
    openCallOffs: listOpenCallOffs(db).length,
    expiringCredentials: credentialsExpiringBetween(
      db,
      now,
      addDays(now, CREDENTIAL_LOOKAHEAD_DAYS),
    ).filter((e) => unitNurseIds.has(e.nurse.id)),
    todayOnShift: onShiftToday(db, unitId, now),
  };
}

function unitOrThrow(db: ShiftNurseDb, unitId: Id) {
  const unit = getUnit(db, unitId);
  if (!unit) throw new Error(`Unknown unit ${unitId}`);
  return unit;
}

function pickImportFile(db: ShiftNurseDb, unitId: Id): RosterImportPreview | undefined {
  const unit = unitOrThrow(db, unitId);
  const win = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogSyncOptions = {
    title: 'Import roster',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  };
  const [path] =
    (win ? dialog.showOpenDialogSync(win, options) : dialog.showOpenDialogSync(options)) ?? [];
  if (!path) return undefined;
  const text = readFileSync(path, 'utf8');
  const { rows, errors } = parseRosterCsv(text, { payPeriodDays: unit.payPeriodDays });
  const existingEmployeeIds = rows
    .map((r) => r.nurse.employeeId)
    .filter((employeeId) => getNurseByEmployeeId(db, unitId, employeeId) !== undefined);
  return { path, rows, errors, existingEmployeeIds };
}

function exportToFile(db: ShiftNurseDb, unitId: Id): string | undefined {
  const unit = unitOrThrow(db, unitId);
  const win = BrowserWindow.getFocusedWindow();
  const options: Electron.SaveDialogSyncOptions = {
    title: 'Export roster',
    defaultPath: `${unit.name.replace(/[^\w-]+/g, '_')}-roster-${today()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  };
  const path = win ? dialog.showSaveDialogSync(win, options) : dialog.showSaveDialogSync(options);
  if (!path) return undefined;
  writeFileSync(path, formatRosterCsv(exportRoster(db, unitId)), 'utf8');
  return path;
}

/** Everything `deriveDemand` needs for a unit, loaded once per call. */
function demandInputs(db: ShiftNurseDb, unitId: Id, start: IsoDate, end: IsoDate) {
  return {
    shiftTypes: listShiftTypesForUnit(db, unitId),
    acuityTiers: listAcuityTiersForUnit(db, unitId),
    ratioRules: listActiveRatioRulesForUnit(db, unitId),
    coverageRequirements: listCoverageRequirementsForUnit(db, unitId),
    censusForecasts: listCensusForecastsInRange(db, unitId, start, end),
    hppdTarget: getHppdTarget(db, unitId),
  };
}

export function createApi(db: ShiftNurseDb): ShiftNurseApi {
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
      pickImportFile: (unitId) => pickImportFile(db, unitId),
      importRows: (unitId, rows) => transact(db, (tx) => importRoster(tx, unitId, rows, ACTOR)),
      exportToFile: (unitId) => exportToFile(db, unitId),
      exportCsv: (unitId) => formatRosterCsv(exportRoster(db, unitId)),
    },
    periods: {
      list: (unitId) => listPeriodsForUnit(db, unitId),
      assignments: (periodId) => listAssignmentsForPeriod(db, periodId),
    },
    timeOff: {
      list: (unitId, status) => listTimeOffForUnit(db, unitId, status),
    },
  };
}
