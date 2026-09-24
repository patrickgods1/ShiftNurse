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
  type Assignment,
  addDays,
  analyseConflicts,
  type BurdenCounters,
  backtest,
  buildRuleContext,
  type CallOff,
  type CallOutcome,
  type ComplianceAlert,
  type ConflictInput,
  type ConflictReport,
  type CounterContext,
  checkStaffing,
  compareDates,
  compareToBudget,
  complianceAlerts,
  costSchedule,
  dateInRange,
  datesInRange,
  defaultRuleSet,
  deriveCounters,
  deriveDemand,
  type ExchangeApplication,
  type ExchangeEvaluation,
  type ExchangeProposal,
  evaluateExchange,
  evaluateSchedule,
  type FairnessLedgerEntry,
  findReplacements,
  formatRosterCsv,
  groupIntoPayPeriods,
  type HistoricalShiftRow,
  type Id,
  type IsoDate,
  type MaxHoursParams,
  maxHoursRule,
  type Nurse,
  type Preference,
  parseHistoricalScheduleCsv,
  parseRosterCsv,
  planExchange,
  proposeCensus,
  type ReplacementReport,
  type Resolution,
  type RuleSet,
  type ScheduleChangeKind,
  type ScheduleChangeSource,
  type SchedulePeriod,
  ScheduleView,
  type ShiftType,
  type SolveInput,
  type SolveReport,
  scoreFairness,
  selectAutoResolutions,
  shiftsAround,
  timeOffImpact,
  today,
} from '@shiftnurse/core';
import {
  applyResolution,
  approveSwap,
  approveTimeOffAndLiftAssignments,
  cancelCallOff,
  cancelSwap,
  cancelTimeOff,
  changesSinceLastPublish,
  costContext,
  createAcuityTier,
  createAssignment,
  createCredential,
  createDifferential,
  createHoliday,
  createNurse,
  createOvertimeRule,
  createPayRate,
  createPeriod,
  createRatioRule,
  createShiftType,
  createTimeOffRequest,
  credentialsExpiringBetween,
  type DbLike,
  deactivateNurse,
  deactivateRatioRule,
  deactivateShiftType,
  deleteAcuityTier,
  deleteAssignment,
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
  getAssignment,
  getBudget,
  getCallOff,
  getConflictPolicy,
  getCurrentDraft,
  getHppdTarget,
  getLatestRuleSet,
  getNurse,
  getNurseByEmployeeId,
  getPeriod,
  getRuleSet,
  getShiftType,
  getSolverSettings,
  getSwap,
  getUnit,
  grantCredential,
  ids,
  importHistoricalLedger,
  importRoster,
  LEDGER_LOOKBACK_DAYS,
  lastCalledAt,
  latestVersion,
  ledgerHistory,
  ledgerPeriodsForUnit,
  ledgerSince,
  listActiveNursesForUnit,
  listAcuityTiersForUnit,
  listAssignmentsForDate,
  listAssignmentsForPeriod,
  listCallAttempts,
  listCallOffsForUnit,
  listCensusForecastsInRange,
  listCensusHistory,
  listChanges,
  listCoverageRequirementsForUnit,
  listCredentials,
  listDifferentialsForUnit,
  listHolidaysForUnit,
  listNurseCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
  listPeriodsForUnit,
  listPreferencesForNurse,
  listPreferencesForUnit,
  listRatioRulesForUnit,
  listShiftCredentialRequirementsForUnit,
  listShiftTypesForUnit,
  listSwapsForPeriod,
  listSwapsForUnit,
  listTimeOffForUnit,
  listTimeOffOverlappingForUnit,
  listUnits,
  listVersions,
  loadPeriodInput,
  logCallAttempt,
  markCallOffCovered,
  markCallOffUncovered,
  moveAssignment,
  openCallOffForAssignment,
  pendingDiff,
  priorAssignmentsBefore,
  proposeSwap,
  publishSchedule,
  recordActualCensus,
  recordScheduleChange,
  replaceAssignments,
  replaceNursePreferences,
  reportCallOff,
  requireChangeReason,
  revokeCredential,
  type ShiftNurseDb,
  saveConflictPolicy,
  saveRuleSet,
  saveSolverSettings,
  setLocked as setAssignmentLocked,
  setBudget,
  transact,
  type UpsertFairnessLedgerInput,
  updateAcuityTier,
  updateAssignment as updateAssignmentDb,
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
import { app, BrowserWindow, dialog } from 'electron';
import type {
  AutoResolveResult,
  BackfillResult,
  CallOffView,
  DashboardSummary,
  DayOfSummary,
  FairnessTrendPoint,
  HistoryImportPreview,
  HistoryImportSummary,
  OnShiftView,
  PeriodCostReport,
  PublishOutcome,
  PublishPreview,
  RosterEntryView,
  RosterImportPreview,
  ScheduleValidation,
  ShiftNurseApi,
  TodayShiftView,
} from '../shared/api.js';
import { createBackup, listBackups, restoreBackup } from './backups.js';
import { databasePath } from './database.js';
import { exportToFile as exportPeriodToFile, type OutputInput, renderCsv } from './output.js';
import { cpsatRunnerPath, ORTOOLS_BACKEND_IDS } from './solver-backends.js';
import { solverAvailability } from './solver-choice.js';
import { SolverJobs } from './solver-jobs.js';

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
    openCallOffs: listCallOffsForUnit(db, unitId, { status: 'open' }).length,
    expiringCredentials: credentialsExpiringBetween(
      db,
      now,
      addDays(now, CREDENTIAL_LOOKAHEAD_DAYS),
    ).filter((e) => unitNurseIds.has(e.nurse.id)),
    todayOnShift: onShiftToday(db, unitId, now),
  };
}

function unitOrThrow(db: DbLike, unitId: Id) {
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

/** The full context and view the rule engine needs to score one period. Loaded once per call. */
function buildScheduleValidation(db: ShiftNurseDb, periodId: Id): ScheduleValidation {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  // The period's own snapshot, never "latest": a published schedule must stay judged by the
  // rules it was solved under, or tightening a rest rule next month would retroactively
  // make last month's schedule non-compliant.
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${periodId} cites unknown rule set ${period.ruleSetId}`);

  const nurses = listNursesForUnit(db, period.unitId);
  const shiftTypes = listShiftTypesForUnit(db, period.unitId);
  const assignments = listAssignmentsForPeriod(db, periodId);
  // Rest and consecutive-shift rules look back across the period boundary into the last
  // published schedule, so a Monday shift can be judged against the Sunday night before it
  // even though that Sunday belongs to a different (already-published) period.
  const prior = priorAssignmentsBefore(db, period.unitId, period.startDate, 14);

  const schedule = new ScheduleView({
    period,
    assignments,
    priorAssignments: prior,
    nurses,
    shiftTypes,
  });
  const ctx = buildRuleContext({
    unit: unitOrThrow(db, period.unitId),
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, period.unitId, period.startDate, period.endDate),
    ),
    nurses,
    shiftTypes,
    timeOff: listTimeOffForUnit(db, period.unitId),
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, period.unitId),
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, period.unitId),
    holidays: listHolidaysForUnit(db, period.unitId),
    weekendDefinition: ruleSet.weekendDefinition,
  });
  return { ruleSet, result: evaluateSchedule(schedule, ruleSet, ctx) };
}

// ---------------------------------------------------------------------------
// Fairness
// ---------------------------------------------------------------------------

function latestRuleSetOrDefault(db: DbLike, unitId: Id): RuleSet {
  return getLatestRuleSet(db, unitId) ?? defaultRuleSet(unitId);
}

/** Everything `deriveCounters` needs for a unit under a given rule set, loaded once. */
function counterContext(db: DbLike, unitId: Id, ruleSet: RuleSet): CounterContext {
  return {
    unit: unitOrThrow(db, unitId),
    holidayDates: new Set<IsoDate>(listHolidaysForUnit(db, unitId).map((h) => h.date)),
    weekendDefinition: ruleSet.weekendDefinition,
    preferences: listPreferencesForUnit(db, unitId),
    timeOff: listTimeOffForUnit(db, unitId),
  };
}

function fairnessReport(db: ShiftNurseDb, periodId: Id) {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  // Same reasoning as validation: the weights and weekend definition the period was created
  // under, not whatever the Rules screen says today.
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${periodId} cites unknown rule set ${period.ruleSetId}`);

  const nurses = listNursesForUnit(db, period.unitId);
  const schedule = new ScheduleView({
    period,
    assignments: listAssignmentsForPeriod(db, periodId),
    nurses,
    shiftTypes: listShiftTypesForUnit(db, period.unitId),
  });
  const ctx = counterContext(db, period.unitId, ruleSet);
  // Only rows strictly before this period: if this period was published before, its own
  // ledger row would otherwise be counted as history *and* as the current draft.
  return scoreFairness({
    nurses: nurses.filter((n) => n.active),
    current: deriveCounters(schedule, ctx),
    history: ledgerHistory(db, period.unitId, period.startDate),
    preferences: ctx.preferences,
    weights: ruleSet.fairnessWeights,
  });
}

function countersFromEntry(entry: FairnessLedgerEntry): BurdenCounters {
  const { id: _id, nurseId: _nurse, periodId: _period, periodStart: _start, ...counters } = entry;
  return counters;
}

/**
 * Re-score each ledger period as it would have looked at the time — judged against only the
 * history before it — so the trend shows whether the unit is getting fairer, not a moving
 * average smeared over the present.
 */
function fairnessTrend(db: ShiftNurseDb, unitId: Id): FairnessTrendPoint[] {
  const entries = ledgerSince(db, unitId, addDays(today(), -LEDGER_LOOKBACK_DAYS));
  const nurses = listActiveNursesForUnit(db, unitId);
  const ruleSet = latestRuleSetOrDefault(db, unitId);
  const preferences = listPreferencesForUnit(db, unitId);

  const byPeriod = new Map<Id, { periodStart: IsoDate; rows: FairnessLedgerEntry[] }>();
  for (const e of entries) {
    const existing = byPeriod.get(e.periodId);
    if (existing) existing.rows.push(e);
    else byPeriod.set(e.periodId, { periodStart: e.periodStart, rows: [e] });
  }
  const periods = [...byPeriod.entries()].sort(
    ([idA, a], [idB, b]) => compareDates(a.periodStart, b.periodStart) || idA.localeCompare(idB),
  );

  return periods.map(([periodId, { periodStart, rows }]) => {
    const report = scoreFairness({
      nurses,
      current: new Map(rows.map((r) => [r.nurseId, countersFromEntry(r)])),
      history: entries.filter((e) => compareDates(e.periodStart, periodStart) < 0),
      preferences,
      weights: ruleSet.fairnessWeights,
    });
    const scores: Record<Id, number> = {};
    for (const s of report.scores) scores[s.nurseId] = s.score;
    return { periodId, periodStart, scores, gini: report.distribution.score.gini };
  });
}

function pickHistoryImportFile(db: ShiftNurseDb, unitId: Id): HistoryImportPreview | undefined {
  const unit = unitOrThrow(db, unitId);
  const win = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogSyncOptions = {
    title: 'Import historical schedule',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  };
  const [path] =
    (win ? dialog.showOpenDialogSync(win, options) : dialog.showOpenDialogSync(options)) ?? [];
  if (!path) return undefined;
  const text = readFileSync(path, 'utf8');
  const { rows, errors } = parseHistoricalScheduleCsv(text, {
    nurses: listNursesForUnit(db, unitId),
    shiftTypes: listShiftTypesForUnit(db, unitId),
  });
  const existing = new Set(ledgerPeriodsForUnit(db, unitId).map((p) => p.periodId));
  const periods = groupIntoPayPeriods(rows, unit).map((p) => ({
    periodId: p.periodId,
    start: p.start,
    end: p.end,
    shifts: p.rows.length,
    nurses: new Set(p.rows.map((r) => r.employeeId)).size,
    replacesExisting: existing.has(p.periodId),
  }));
  return { path, rows, errors, periods };
}

/**
 * Turn imported shifts into ledger rows by running each pay period through the same
 * `deriveCounters` a published period will use, so imported history and app-generated history
 * are counted identically — a weekend is a weekend under the same definition either way.
 */
function importHistory(
  db: ShiftNurseDb,
  unitId: Id,
  rows: readonly HistoricalShiftRow[],
): HistoryImportSummary {
  return transact(db, (tx) => {
    const unit = unitOrThrow(tx, unitId);
    const ruleSet = latestRuleSetOrDefault(tx, unitId);
    const nurses = listNursesForUnit(tx, unitId);
    const shiftTypes = listShiftTypesForUnit(tx, unitId);
    const nurseByEmployeeId = new Map<string, Nurse>(nurses.map((n) => [n.employeeId, n]));
    const shiftTypeByAbbreviation = new Map<string, ShiftType>(
      shiftTypes.map((s) => [s.abbreviation.toLowerCase(), s]),
    );
    const ctx = counterContext(tx, unitId, ruleSet);

    const entries: UpsertFairnessLedgerInput[] = [];
    const periods = groupIntoPayPeriods(rows, unit);
    for (const group of periods) {
      const period: SchedulePeriod = {
        id: group.periodId,
        unitId,
        name: `Imported ${group.start}`,
        startDate: group.start,
        endDate: group.end,
        status: 'archived',
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      };
      const assignments: Assignment[] = group.rows.map((r, i) => {
        const nurse = nurseByEmployeeId.get(r.employeeId);
        const shiftType = shiftTypeByAbbreviation.get(r.shiftAbbreviation.toLowerCase());
        // The preview already validated these; a mismatch here means the roster changed
        // between preview and import, which must not become a silently mis-attributed shift.
        if (!nurse) throw new Error(`Unknown employee id ${r.employeeId}`);
        if (!shiftType) throw new Error(`Unknown shift abbreviation ${r.shiftAbbreviation}`);
        return {
          id: `${group.periodId}:${i}`,
          periodId: group.periodId,
          nurseId: nurse.id,
          shiftTypeId: shiftType.id,
          date: r.date,
          source: 'manual',
          isLocked: false,
          isCharge: false,
          isOvertime: false,
        };
      });
      const schedule = new ScheduleView({ period, assignments, nurses, shiftTypes });
      const present = new Set(assignments.map((a) => a.nurseId));
      for (const [nurseId, counters] of deriveCounters(schedule, ctx)) {
        // Only nurses who appear in this period's file: a nurse absent from a period may not
        // have been on the unit yet, and a zero row would read as "worked no nights" rather
        // than "no record".
        if (!present.has(nurseId)) continue;
        entries.push({ nurseId, periodId: group.periodId, periodStart: group.start, ...counters });
      }
    }
    const result = importHistoricalLedger(tx, unitId, entries, ACTOR);
    return {
      periodsImported: periods.length,
      entriesWritten: result.written,
      entriesReplaced: result.replaced,
    };
  });
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

function costReport(db: ShiftNurseDb, periodId: Id): PeriodCostReport {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  // The period's own snapshot: the weekend definition and work week it was solved under.
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${periodId} cites unknown rule set ${period.ruleSetId}`);

  const schedule = new ScheduleView({
    period,
    assignments: listAssignmentsForPeriod(db, periodId),
    // Weekly overtime can straddle the period boundary just as the rest rules do.
    priorAssignments: priorAssignmentsBefore(db, period.unitId, period.startDate, 14),
    nurses: listNursesForUnit(db, period.unitId),
    shiftTypes: listShiftTypesForUnit(db, period.unitId),
  });
  const cost = costSchedule(schedule, costContext(db, period.unitId, ruleSet));
  const budget = getBudget(db, periodId);
  return {
    period,
    cost,
    budget,
    variance: budget ? compareToBudget(cost.totals.total, budget.targetDollars) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Publish, change log, output
// ---------------------------------------------------------------------------

/** How far a nurse may drift from contracted hours before the publish preview flags it. */
const HOURS_DRIFT_TOLERANCE = 0.1;

function periodOrThrow(db: DbLike, periodId: Id): SchedulePeriod {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  return period;
}

function ruleSetFor(db: DbLike, period: SchedulePeriod): RuleSet {
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${period.id} cites unknown rule set ${period.ruleSetId}`);
  return ruleSet;
}

/** The view every output and alert pass reads: the period's rows plus the lookback tail. */
function scheduleViewFor(db: DbLike, period: SchedulePeriod): ScheduleView {
  return new ScheduleView({
    period,
    assignments: listAssignmentsForPeriod(db, period.id),
    priorAssignments: priorAssignmentsBefore(db, period.unitId, period.startDate, 14),
    nurses: listNursesForUnit(db, period.unitId),
    shiftTypes: listShiftTypesForUnit(db, period.unitId),
  });
}

function alertsFor(db: DbLike, periodId: Id): ComplianceAlert[] {
  const period = periodOrThrow(db, periodId);
  const ruleSet = ruleSetFor(db, period);
  const maxHours = ruleSet.configs.find((c) => c.ruleId === maxHoursRule.id);
  const params = { ...maxHoursRule.defaultParams, ...(maxHours?.params ?? {}) } as MaxHoursParams;
  return complianceAlerts({
    schedule: scheduleViewFor(db, period),
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, period.unitId),
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, period.unitId, period.startDate, period.endDate),
    ).all(),
    overtimeThresholdHours: params.overtimeThresholdHours,
    workWeekStartsOn: params.workWeekStartsOn,
    hoursDriftTolerance: HOURS_DRIFT_TOLERANCE,
    payPeriodDays: unitOrThrow(db, period.unitId).payPeriodDays,
  });
}

function publishPreview(db: ShiftNurseDb, periodId: Id): PublishPreview {
  const period = periodOrThrow(db, periodId);
  const latest = latestVersion(db, periodId);
  const diff = pendingDiff(db, periodId);
  const { result } = buildScheduleValidation(db, periodId);
  return {
    period,
    latestVersion: latest,
    diff,
    pendingChanges: changesSinceLastPublish(db, periodId),
    alerts: alertsFor(db, periodId),
    hardViolations: result.hardViolations.length,
    softViolations: result.softViolations.length,
    nothingToPublish: latest !== undefined && diff.changes.length === 0,
  };
}

/**
 * Version, status, ledger and audit in one transaction; then the backup. The backup comes
 * after the commit on purpose — a backup of a database that then rolled back would be a
 * copy of a schedule nobody published — and a backup failure is reported, not fatal: the
 * publish itself has already happened and must not be reported as failed.
 */
async function publish(db: ShiftNurseDb, periodId: Id, reason?: string): Promise<PublishOutcome> {
  const committed = transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    const ruleSet = ruleSetFor(tx, period);
    const nurses = listNursesForUnit(tx, period.unitId);
    const schedule = new ScheduleView({
      period,
      assignments: listAssignmentsForPeriod(tx, periodId),
      nurses,
      shiftTypes: listShiftTypesForUnit(tx, period.unitId),
    });
    // The ledger takes what was actually scheduled, derived by the same `deriveCounters`
    // that scores fairness and imports history, so all three agree on what a weekend is.
    const present = new Set(schedule.assignments().map((v) => v.nurse.id));
    const ledger: UpsertFairnessLedgerInput[] = [];
    for (const [nurseId, counters] of deriveCounters(
      schedule,
      counterContext(tx, period.unitId, ruleSet),
    )) {
      if (!present.has(nurseId)) continue;
      ledger.push({ nurseId, periodId, periodStart: period.startDate, ...counters });
    }
    return publishSchedule(tx, { periodId, reason, ledger }, ACTOR);
  });
  let backup: PublishOutcome['backup'];
  try {
    backup = await createBackup(
      db,
      'publish',
      `${committed.period.name}-v${committed.version.version}`,
    );
  } catch (err) {
    console.error(`[backup] publish backup failed: ${err instanceof Error ? err.message : err}`);
  }
  return { ...committed, backup };
}

/** Exported for the smoke test, which renders a real PDF in main without a save dialog. */
export function outputInput(db: ShiftNurseDb, periodId: Id): OutputInput {
  const period = periodOrThrow(db, periodId);
  return {
    schedule: scheduleViewFor(db, period),
    ctx: {
      unit: unitOrThrow(db, period.unitId),
      version: latestVersion(db, periodId),
      status: period.status,
      alerts: alertsFor(db, periodId),
    },
  };
}

interface ChangeLogEntry {
  kind: ScheduleChangeKind;
  assignment: Assignment;
  before?: Assignment;
  after?: Assignment;
}

/**
 * Run a grid edit inside one transaction and, when the period is published, write each
 * touched shift to the change log under the manager's reason. On a draft `log` is a no-op
 * and the reason is dropped; on an archived period the edit is refused before it starts.
 */
function editSchedule<T>(
  db: ShiftNurseDb,
  periodId: Id,
  reason: string | undefined,
  source: ScheduleChangeSource,
  work: (tx: DbLike, log: (entry: ChangeLogEntry) => void) => T,
): T {
  return transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    const required = requireChangeReason(period, reason);
    const log = (entry: ChangeLogEntry) => {
      if (required === undefined) return;
      const a = entry.assignment;
      recordScheduleChange(
        tx,
        {
          periodId,
          kind: entry.kind,
          source,
          assignmentId: a.id,
          nurseId: a.nurseId,
          date: a.date,
          shiftTypeId: a.shiftTypeId,
          before: entry.before,
          after: entry.after,
          reason: required,
        },
        ACTOR,
      );
    };
    return work(tx, log);
  });
}

function assignmentOrThrow(db: DbLike, assignmentId: Id): Assignment {
  const existing = getAssignment(db, assignmentId);
  if (!existing) throw new Error(`Assignment ${assignmentId} not found`);
  return existing;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/**
 * Everything the solver needs for one draft period, as plain rows. Loaded the same way
 * validation, fairness and costing load their inputs — the period's own rule-set snapshot,
 * the 14-day lookback tail, ledger history strictly before the period — so the schedule the
 * solver emits is judged by exactly the machinery that will judge it on screen.
 */
function buildSolveInput(db: ShiftNurseDb, periodId: Id): SolveInput {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  if (period.status !== 'draft') {
    throw new Error(`Period "${period.name}" is ${period.status}; only a draft can be generated`);
  }
  return loadPeriodInput(db, period);
}

/**
 * The same rows the solver sees, plus the budget, for conflict detection. Analysis is
 * read-only, so a published period is fine here — the manager may want to know what a
 * late approval did to last week's schedule — while *applying* a resolution is refused for
 * anything but a draft inside `applyResolution` itself.
 */
function buildConflictInput(db: DbLike, periodId: Id): ConflictInput {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  const budget = getBudget(db, periodId);
  return { ...loadPeriodInput(db, period), ...(budget ? { budget } : {}) };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

function analyse(db: ShiftNurseDb, periodId: Id): ConflictReport {
  return analyseConflicts(buildConflictInput(db, periodId));
}

/**
 * Each resolution is applied in its own transaction and the period is re-analysed between
 * them: applying one option can close (or change) a neighbouring conflict, and a stale option
 * must be dropped rather than double-booked. The pass stops at the first refusal so a
 * surprising state is left for the manager to see, not papered over.
 */
function autoResolve(db: ShiftNurseDb, periodId: Id): AutoResolveResult {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  const policy = getConflictPolicy(db, period.unitId);
  const applied: Resolution[] = [];
  if (!policy.enabled) return { applied, report: analyse(db, periodId) };

  const seen = new Set<string>();
  for (;;) {
    const report = analyse(db, periodId);
    const next = selectAutoResolutions(report, policy).find((r) => !seen.has(r.id));
    if (!next) return { applied, report };
    seen.add(next.id);
    transact(db, (tx) => applyResolution(tx, periodId, next, ACTOR, { auto: true }));
    applied.push(next);
  }
}

// ---------------------------------------------------------------------------
// Day-of
// ---------------------------------------------------------------------------

/** How far back the call log is read when spreading calls across the pool. */
const LAST_CALL_LOOKBACK_DAYS = 180;

const PERIOD_STATUS_PRIORITY: Record<SchedulePeriod['status'], number> = {
  published: 0,
  draft: 1,
  archived: 2,
};

/** The period covering a date, preferring a published one over a draft over an archived one. */
function periodCoveringDate(db: DbLike, unitId: Id, date: IsoDate): SchedulePeriod | undefined {
  const covering = listPeriodsForUnit(db, unitId).filter((p) =>
    dateInRange(date, p.startDate, p.endDate),
  );
  covering.sort((a, b) => PERIOD_STATUS_PRIORITY[a.status] - PERIOD_STATUS_PRIORITY[b.status]);
  return covering[0];
}

/**
 * The one place main reads the wall clock for "what shift is running right now" — the same
 * exception `today()` makes: this is an event (what time is it), not schedule geometry.
 */
function hostMinuteOfDay(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function getCallOffOrThrow(db: DbLike, id: Id): CallOff {
  const callOff = getCallOff(db, id);
  if (!callOff) throw new Error(`Call-off ${id} not found`);
  return callOff;
}

function callOffView(db: DbLike, callOff: CallOff): CallOffView {
  const nurse = getNurse(db, callOff.nurseId);
  if (!nurse) throw new Error(`Unknown nurse ${callOff.nurseId}`);
  const shiftType = getShiftType(db, callOff.shiftTypeId);
  if (!shiftType) throw new Error(`Unknown shift type ${callOff.shiftTypeId}`);
  const period = periodOrThrow(db, callOff.periodId);
  const assignment = getAssignment(db, callOff.assignmentId);
  const attempts = listCallAttempts(db, callOff.id);

  let replacement: CallOffView['replacement'];
  if (callOff.replacementAssignmentId !== undefined) {
    const row = getAssignment(db, callOff.replacementAssignmentId);
    const repNurse = row ? getNurse(db, row.nurseId) : undefined;
    if (row && repNurse) replacement = { assignment: row, nurse: repNurse };
  }

  return {
    callOff,
    ...(assignment ? { assignment } : {}),
    nurse,
    shiftType,
    period,
    attempts,
    ...(replacement ? { replacement } : {}),
  };
}

/** One (date, shiftType) slot the Today screen shows, with its current/next/other precedence. */
interface StatusSlot {
  date: IsoDate;
  shiftTypeId: Id;
  status: 'current' | 'next' | 'other';
}

/**
 * Current slots first, then the next slot, then every active type on `date` in sort order —
 * deduped on `(date, shiftTypeId)` so a shift that is both "current" (spanning midnight) and
 * "on today's list" appears once, tagged with its highest-precedence status.
 */
function collectSlots(
  shiftTypes: readonly ShiftType[],
  date: IsoDate,
  around: ReturnType<typeof shiftsAround>,
): StatusSlot[] {
  const byKey = new Map<string, StatusSlot>();
  const upsert = (slotDate: IsoDate, shiftTypeId: Id, status: StatusSlot['status']) => {
    const key = `${slotDate}::${shiftTypeId}`;
    if (!byKey.has(key)) byKey.set(key, { date: slotDate, shiftTypeId, status });
  };
  for (const s of around.current) upsert(s.date, s.shiftTypeId, 'current');
  if (around.next) upsert(around.next.date, around.next.shiftTypeId, 'next');
  for (const t of [...shiftTypes]
    .filter((t) => t.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    upsert(date, t.id, 'other');
  }
  return [...byKey.values()];
}

/** Everything one date needs for its staffing check: the covering period's own assignments. */
function planForDate(
  db: DbLike,
  unitId: Id,
  shiftTypes: readonly ShiftType[],
  nurses: readonly Nurse[],
  date: IsoDate,
) {
  const period = periodCoveringDate(db, unitId, date);
  const assignments = period
    ? listAssignmentsForDate(db, date).filter((a) => a.periodId === period.id)
    : [];
  const checks = checkStaffing({
    date,
    shiftTypes,
    nurses,
    assignments,
    demand: demandInputs(db, unitId, date, date),
  });
  const census = listCensusForecastsInRange(db, unitId, date, date);
  return { period, assignments, checks, census };
}

function dayOfSummary(db: ShiftNurseDb, unitId: Id, date?: IsoDate): DayOfSummary {
  const d = date ?? today();
  const minuteOfDay = hostMinuteOfDay();
  const shiftTypes = listShiftTypesForUnit(db, unitId);
  const nurses = listNursesForUnit(db, unitId);
  const shiftTypeById = new Map(shiftTypes.map((t) => [t.id, t]));
  const nurseById = new Map(nurses.map((n) => [n.id, n]));

  const around = shiftsAround(shiftTypes, d, minuteOfDay);
  const slots = collectSlots(shiftTypes, d, around);

  // Loaded once: every open call-off on the unit, whatever its date, so a roster row can show
  // the call-off against it without a query per assignment.
  const openCallOffRows = listCallOffsForUnit(db, unitId, { status: 'open' });
  const callOffByAssignment = new Map(openCallOffRows.map((c) => [c.assignmentId, c]));

  const dates = [...new Set(slots.map((s) => s.date))];
  const perDate = new Map<IsoDate, ReturnType<typeof planForDate>>();
  for (const slotDate of dates) {
    perDate.set(slotDate, planForDate(db, unitId, shiftTypes, nurses, slotDate));
  }

  const shifts: TodayShiftView[] = slots.map((slot) => {
    const plan = perDate.get(slot.date);
    if (!plan) throw new Error(`No staffing plan computed for ${slot.date}`);
    const shiftType = shiftTypeById.get(slot.shiftTypeId);
    if (!shiftType) throw new Error(`Unknown shift type ${slot.shiftTypeId}`);
    const staffing = plan.checks.find((c) => c.shiftTypeId === slot.shiftTypeId);
    if (!staffing) throw new Error(`No staffing check for ${slot.date} ${slot.shiftTypeId}`);
    const census = plan.census.find(
      (c) => c.shiftTypeId === slot.shiftTypeId && c.date === slot.date,
    );
    const roster: RosterEntryView[] = plan.assignments
      .filter((a) => a.shiftTypeId === slot.shiftTypeId && a.date === slot.date)
      .map((a) => {
        const nurse = nurseById.get(a.nurseId);
        if (!nurse) throw new Error(`Unknown nurse ${a.nurseId}`);
        const callOff = callOffByAssignment.get(a.id);
        return { assignment: a, nurse, ...(callOff ? { callOff } : {}) };
      })
      .sort(
        (x, y) =>
          x.nurse.lastName.localeCompare(y.nurse.lastName) ||
          x.nurse.firstName.localeCompare(y.nurse.firstName),
      );
    return {
      date: slot.date,
      shiftType,
      ...(census ? { census } : {}),
      staffing,
      roster,
      status: slot.status,
    };
  });

  return {
    date: d,
    minuteOfDay,
    period: periodCoveringDate(db, unitId, d),
    shifts,
    openCallOffs: openCallOffRows.map((c) => callOffView(db, c)),
  };
}

function reportDayOfCallOff(db: ShiftNurseDb, assignmentId: Id, reason?: string): CallOff {
  if (openCallOffForAssignment(db, assignmentId)) {
    throw new Error('A call-off is already open for this assignment');
  }
  const absent = assignmentOrThrow(db, assignmentId);
  const period = periodOrThrow(db, absent.periodId);
  if (period.status === 'archived') {
    throw new Error(`Period "${period.name}" is archived; cannot report a call-off against it`);
  }
  return reportCallOff(db, assignmentId, ACTOR, reason);
}

/** Ranked, eligible-only replacements, simulated on the period's own rule-set snapshot. */
function replacementsFor(db: DbLike, callOffId: Id): ReplacementReport {
  const callOff = getCallOffOrThrow(db, callOffId);
  if (callOff.status !== 'open') {
    throw new Error(`Call-off ${callOffId} is ${callOff.status}, not open`);
  }
  const period = periodOrThrow(db, callOff.periodId);
  const lastCalled = Object.fromEntries(
    lastCalledAt(db, period.unitId, addDays(today(), -LAST_CALL_LOOKBACK_DAYS)),
  );
  return findReplacements({
    ...buildConflictInput(db, callOff.periodId),
    absentAssignmentId: callOff.assignmentId,
    lastCalledAt: lastCalled,
  });
}

function logCall(
  db: ShiftNurseDb,
  callOffId: Id,
  nurseId: Id,
  outcome: Exclude<CallOutcome, 'accepted'>,
  notes?: string,
) {
  // Defence in depth: the type excludes `'accepted'`, but IPC input is not type-checked at
  // runtime, and an accepted call must never bypass the row it also has to write.
  if ((outcome as CallOutcome) === 'accepted') {
    throw new Error('An accepted call is recorded through backfill, which also writes the shift');
  }
  return logCallAttempt(db, callOffId, nurseId, outcome, ACTOR, notes);
}

/**
 * The nurse said yes. Re-runs `findReplacements` immediately before writing — never trusting a
 * renderer-sent verdict, exactly as `exchange.approve` re-evaluates before applying — then
 * replaces the absent assignment with the candidate's row in one transaction, through the
 * published-schedule change log as `source: 'backfill'`.
 */
function backfill(db: ShiftNurseDb, callOffId: Id, nurseId: Id, notes?: string): BackfillResult {
  const callOff = getCallOffOrThrow(db, callOffId);
  if (callOff.status !== 'open') {
    throw new Error(`Call-off ${callOffId} is ${callOff.status}, not open`);
  }
  if (!getNurse(db, nurseId)) throw new Error(`Unknown nurse ${nurseId}`);
  // The reason names who was ABSENT — that is the fact being explained. The replacement's
  // name is already on the `added` row the change log writes below.
  const absentNurse = getNurse(db, callOff.nurseId);
  if (!absentNurse) throw new Error(`Unknown nurse ${callOff.nurseId}`);
  const shiftType = getShiftType(db, callOff.shiftTypeId);
  if (!shiftType) throw new Error(`Unknown shift type ${callOff.shiftTypeId}`);
  const reason =
    `Call-off: ${absentNurse.firstName} ${absentNurse.lastName}, ${callOff.date} ${shiftType.abbreviation}` +
    (callOff.reason ? ` — ${callOff.reason}` : '');

  return editSchedule(db, callOff.periodId, reason, 'backfill', (tx, log) => {
    const absent = assignmentOrThrow(tx, callOff.assignmentId);
    const report = findReplacements({
      ...buildConflictInput(tx, callOff.periodId),
      absentAssignmentId: absent.id,
      lastCalledAt: {},
    });
    const candidate = report.candidates.find((c) => c.nurseId === nurseId);
    if (!candidate) {
      const excluded = report.excluded.find((e) => e.nurseId === nurseId);
      throw new Error(
        excluded
          ? `${excluded.label} is not eligible for this shift: ${excluded.reason}`
          : `Nurse ${nurseId} is not eligible for this shift`,
      );
    }
    deleteAssignment(tx, absent.id, ACTOR, reason);
    log({ kind: 'removed', assignment: absent, before: absent });
    const created = createAssignment(
      tx,
      { ...candidate.assignment, ...(notes ? { notes } : {}) },
      ACTOR,
      reason,
    );
    log({ kind: 'added', assignment: created, after: created });
    const attempt = logCallAttempt(tx, callOff.id, nurseId, 'accepted', ACTOR, notes);
    const covered = markCallOffCovered(tx, callOff.id, created.id, ACTOR);
    return { callOff: covered, attempt, assignment: created };
  });
}

/** Write a finished solve into its period: unlocked rows replaced, locked rows untouched, audited. */
function applySolveReport(db: ShiftNurseDb, periodId: Id, report: SolveReport) {
  return transact(db, (tx) => {
    const period = getPeriod(tx, periodId);
    if (!period) throw new Error(`Unknown period ${periodId}`);
    if (period.status !== 'draft') {
      throw new Error(`Period "${period.name}" was ${period.status} before the solve finished`);
    }
    const proposed = report.assignments.filter((a) => !a.isLocked);
    const written = replaceAssignments(
      tx,
      periodId,
      proposed.map((a) => ({
        periodId,
        nurseId: a.nurseId,
        shiftTypeId: a.shiftTypeId,
        date: a.date,
        source: 'solver' as const,
        isCharge: a.isCharge,
        isOvertime: a.isOvertime,
      })),
      ACTOR,
      {
        solver: report.stats.solver,
        seed: report.stats.seed,
        ...(report.stats.fellBackFrom ? { fellBackFrom: report.stats.fellBackFrom } : {}),
      },
    );
    const preservedLocked = written.filter((a) => a.isLocked).length;
    return { created: written.length - preservedLocked, preservedLocked };
  });
}

export function createSolverJobs(db: ShiftNurseDb): SolverJobs {
  return new SolverJobs({
    loadInput: (periodId) => buildSolveInput(db, periodId),
    apply: (periodId, report) => applySolveReport(db, periodId, report),
    settings: (periodId) => {
      const period = getPeriod(db, periodId);
      if (!period) throw new Error(`Unknown period ${periodId}`);
      return getSolverSettings(db, period.unitId);
    },
    availability: () => solverAvailability(cpsatRunnerPath() !== undefined, ORTOOLS_BACKEND_IDS),
    runnerPath: cpsatRunnerPath,
  });
}

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
      pickImportFile: (unitId) => pickImportFile(db, unitId),
      importRows: (unitId, rows) => transact(db, (tx) => importRoster(tx, unitId, rows, ACTOR)),
      exportToFile: (unitId) => exportToFile(db, unitId),
      exportCsv: (unitId) => formatRosterCsv(exportRoster(db, unitId)),
    },
    periods: {
      list: (unitId) => listPeriodsForUnit(db, unitId),
      assignments: (periodId) => listAssignmentsForPeriod(db, periodId),
      create: ({ unitId, name, startDate, endDate }) => {
        const ruleSet =
          getLatestRuleSet(db, unitId) ?? saveRuleSet(db, defaultRuleSet(unitId), ACTOR);
        return createPeriod(
          db,
          {
            unitId,
            name,
            startDate,
            endDate,
            ruleSetId: ruleSet.id,
            ruleSetVersion: ruleSet.version,
          },
          ACTOR,
        );
      },
    },
    schedule: {
      validate: (periodId) => buildScheduleValidation(db, periodId),
      createAssignment: (input, reason) =>
        editSchedule(db, input.periodId, reason, 'manual', (tx, log) => {
          const created = createAssignment(
            tx,
            { ...input, source: input.source ?? 'manual' },
            ACTOR,
            reason,
          );
          log({ kind: 'added', assignment: created, after: created });
          return created;
        }),
      moveAssignment: ({ assignmentId, nurseId, shiftTypeId, date }, reason) => {
        const existing = assignmentOrThrow(db, assignmentId);
        return editSchedule(db, existing.periodId, reason, 'manual', (tx, log) => {
          const moved = moveAssignment(
            tx,
            assignmentId,
            { nurseId, shiftTypeId, date },
            ACTOR,
            'manual',
            reason,
          );
          log({ kind: 'removed', assignment: existing, before: existing });
          log({ kind: 'added', assignment: moved, after: moved });
          return moved;
        });
      },
      updateAssignment: (assignmentId, patch, reason) => {
        const existing = assignmentOrThrow(db, assignmentId);
        return editSchedule(db, existing.periodId, reason, 'manual', (tx, log) => {
          const updated = updateAssignmentDb(tx, assignmentId, patch, ACTOR, reason);
          log({ kind: 'changed', assignment: existing, before: existing, after: updated });
          return updated;
        });
      },
      deleteAssignment: (assignmentId, reason) => {
        const existing = assignmentOrThrow(db, assignmentId);
        editSchedule(db, existing.periodId, reason, 'manual', (tx, log) => {
          deleteAssignment(tx, assignmentId, ACTOR, reason);
          log({ kind: 'removed', assignment: existing, before: existing });
        });
      },
      setLocked: (assignmentId, locked) => setAssignmentLocked(db, assignmentId, locked, ACTOR),
    },
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
      restore: (fileName) => restoreBackup(db, fileName),
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
      setBudget: (periodId, targetDollars) => {
        const period = getPeriod(db, periodId);
        if (!period) throw new Error(`Unknown period ${periodId}`);
        return setBudget(db, period.unitId, periodId, targetDollars, ACTOR);
      },
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
      approve: (id, reason) =>
        transact(db, (tx) => {
          const swap = getSwap(tx, id);
          if (!swap) throw new Error(`Shift swap ${id} not found`);
          if (swap.status !== 'proposed') {
            throw new Error(`Shift swap ${id} is ${swap.status}, not proposed; nothing to decide`);
          }
          const proposal: ExchangeProposal = {
            kind: swap.kind,
            requestingNurseId: swap.requestingNurseId,
            counterpartyNurseId: swap.counterpartyNurseId,
            offeredAssignmentId: swap.offeredAssignmentId,
            requestedAssignmentId: swap.requestedAssignmentId,
          };
          // Re-evaluated from the stored swap, not from anything the renderer sent: a verdict
          // is only trustworthy when it is computed here, against the period's current state,
          // immediately before the write that acts on it.
          const exchangeInput = { ...buildConflictInput(tx, swap.periodId), proposal };
          const evaluation: ExchangeEvaluation = evaluateExchange(exchangeInput);
          if (evaluation.verdict === 'blocked') {
            throw new Error(
              `Exchange blocked: ${evaluation.blockers.join('; ') || 'a hard rule would break'}`,
            );
          }
          const overrode = evaluation.verdict === 'warn';
          const application: ExchangeApplication = planExchange(exchangeInput);
          return approveSwap(tx, id, application, ACTOR, { overrode, reason });
        }),
      deny: (id, reason) => denySwap(db, id, ACTOR, reason),
      cancel: (id, reason) => cancelSwap(db, id, ACTOR, reason),
    },
    dayOf: {
      today: (unitId, date) => dayOfSummary(db, unitId, date),
      callOffs: (unitId, start, end) =>
        listCallOffsForUnit(db, unitId, { start, end }).map((c) => callOffView(db, c)),
      reportCallOff: (assignmentId, reason) => reportDayOfCallOff(db, assignmentId, reason),
      replacements: (callOffId) => replacementsFor(db, callOffId),
      logCall: (callOffId, nurseId, outcome, notes) =>
        logCall(db, callOffId, nurseId, outcome, notes),
      backfill: (callOffId, nurseId, notes) => backfill(db, callOffId, nurseId, notes),
      markUncovered: (callOffId, reason) => markCallOffUncovered(db, callOffId, ACTOR, reason),
      cancelCallOff: (callOffId, reason) => cancelCallOff(db, callOffId, ACTOR, reason),
      callLog: (callOffId) => listCallAttempts(db, callOffId),
    },
  };
}
