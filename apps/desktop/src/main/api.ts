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
  type ConflictInput,
  type ConflictReport,
  type CostContext,
  type CounterContext,
  compareDates,
  compareToBudget,
  costSchedule,
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
  type Resolution,
  type RuleSet,
  type SchedulePeriod,
  ScheduleView,
  type ShiftType,
  type SolveInput,
  type SolveReport,
  scoreFairness,
  selectAutoResolutions,
  timeOffImpact,
  today,
} from '@shiftnurse/core';
import {
  applyResolution,
  approveSwap,
  approveTimeOffAndLiftAssignments,
  cancelSwap,
  cancelTimeOff,
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
  denySwap,
  denyTimeOff,
  exportRoster,
  getBudget,
  getConflictPolicy,
  getCurrentDraft,
  getHppdTarget,
  getLatestRuleSet,
  getNurse,
  getNurseByEmployeeId,
  getPeriod,
  getRuleSet,
  getSwap,
  getUnit,
  grantCredential,
  ids,
  importHistoricalLedger,
  importRoster,
  ledgerPeriodsForUnit,
  ledgerSince,
  listActiveDifferentials,
  listActiveNursesForUnit,
  listActiveOvertimeRules,
  listActiveRatioRulesForUnit,
  listAcuityTiersForUnit,
  listAssignmentsForDate,
  listAssignmentsForPeriod,
  listCensusForecastsInRange,
  listCensusHistory,
  listCoverageRequirementsForUnit,
  listCredentials,
  listDifferentialsForUnit,
  listHolidaysForUnit,
  listNurseCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listOpenCallOffs,
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
  moveAssignment,
  priorAssignmentsBefore,
  proposeSwap,
  recordActualCensus,
  replaceAssignments,
  replaceNursePreferences,
  revokeCredential,
  type ShiftNurseDb,
  saveConflictPolicy,
  saveRuleSet,
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
  DashboardSummary,
  FairnessTrendPoint,
  HistoryImportPreview,
  HistoryImportSummary,
  OnShiftView,
  PeriodCostReport,
  RosterImportPreview,
  ScheduleValidation,
  ShiftNurseApi,
} from '../shared/api.js';
import { databasePath } from './database.js';
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
    openCallOffs: listOpenCallOffs(db).length,
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

/** Everything `deriveDemand` needs for a unit, loaded once per call. */
function demandInputs(db: DbLike, unitId: Id, start: IsoDate, end: IsoDate) {
  return {
    shiftTypes: listShiftTypesForUnit(db, unitId),
    acuityTiers: listAcuityTiersForUnit(db, unitId),
    ratioRules: listActiveRatioRulesForUnit(db, unitId),
    coverageRequirements: listCoverageRequirementsForUnit(db, unitId),
    censusForecasts: listCensusForecastsInRange(db, unitId, start, end),
    hppdTarget: getHppdTarget(db, unitId),
  };
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

/**
 * How far back the ledger is read. The burden window is 13 periods (~6 months of two-week
 * periods) with decay, so a year of rows is more than enough and keeps the query bounded on
 * a unit that has imported years of history.
 */
const LEDGER_LOOKBACK_DAYS = 400;

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

function ledgerHistory(db: DbLike, unitId: Id, before: IsoDate): FairnessLedgerEntry[] {
  return ledgerSince(db, unitId, addDays(before, -LEDGER_LOOKBACK_DAYS)).filter(
    (e) => compareDates(e.periodStart, before) < 0,
  );
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

/**
 * Everything `costSchedule` needs for a unit under a given rule set. The work-week start comes
 * from the max-hours rule's parameters so weekly overtime is counted over the same week the
 * rule engine polices — two different "weeks" would let a shift be flagged as overtime by the
 * rules and priced as straight time, or the reverse.
 */
function costContext(db: DbLike, unitId: Id, ruleSet: RuleSet): CostContext {
  const maxHours = ruleSet.configs.find((c) => c.ruleId === maxHoursRule.id);
  const params = (maxHours?.params ?? maxHoursRule.defaultParams) as Partial<MaxHoursParams>;
  return {
    unit: unitOrThrow(db, unitId),
    payRates: listPayRatesForUnit(db, unitId),
    differentials: listActiveDifferentials(db, unitId),
    overtimeRules: listActiveOvertimeRules(db, unitId),
    holidayDates: new Set<IsoDate>(listHolidaysForUnit(db, unitId).map((h) => h.date)),
    weekendDefinition: ruleSet.weekendDefinition,
    workWeekStartsOn: params.workWeekStartsOn ?? maxHoursRule.defaultParams.workWeekStartsOn,
  };
}

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

/** Shared loader behind the solver and the conflict detector: one definition of "the period". */
function loadPeriodInput(db: DbLike, period: SchedulePeriod): SolveInput {
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${period.id} cites unknown rule set ${period.ruleSetId}`);
  const unitId = period.unitId;
  const cost = costContext(db, unitId, ruleSet);
  return {
    unit: unitOrThrow(db, unitId),
    period,
    ruleSet,
    nurses: listNursesForUnit(db, unitId),
    shiftTypes: listShiftTypesForUnit(db, unitId),
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, unitId, period.startDate, period.endDate),
    ).all(),
    assignments: listAssignmentsForPeriod(db, period.id),
    priorAssignments: priorAssignmentsBefore(db, unitId, period.startDate, 14),
    timeOff: listTimeOffForUnit(db, unitId),
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, unitId),
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, unitId),
    holidays: listHolidaysForUnit(db, unitId),
    preferences: listPreferencesForUnit(db, unitId),
    ledgerHistory: ledgerHistory(db, unitId, period.startDate),
    cost: {
      payRates: cost.payRates,
      differentials: cost.differentials,
      overtimeRules: cost.overtimeRules,
    },
  };
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
    );
    const preservedLocked = written.filter((a) => a.isLocked).length;
    return { created: written.length - preservedLocked, preservedLocked };
  });
}

export function createSolverJobs(db: ShiftNurseDb): SolverJobs {
  return new SolverJobs({
    loadInput: (periodId) => buildSolveInput(db, periodId),
    apply: (periodId, report) => applySolveReport(db, periodId, report),
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
      createAssignment: (input) =>
        createAssignment(db, { ...input, source: input.source ?? 'manual' }, ACTOR),
      moveAssignment: ({ assignmentId, nurseId, shiftTypeId, date }) =>
        transact(db, (tx) =>
          moveAssignment(tx, assignmentId, { nurseId, shiftTypeId, date }, ACTOR),
        ),
      updateAssignment: (assignmentId, patch) => updateAssignmentDb(db, assignmentId, patch, ACTOR),
      deleteAssignment: (assignmentId) => deleteAssignment(db, assignmentId, ACTOR),
      setLocked: (assignmentId, locked) => setAssignmentLocked(db, assignmentId, locked, ACTOR),
    },
    solver: {
      start: (periodId, options) => solverJobs.start(periodId, options),
      status: (jobId) => solverJobs.status(jobId),
      cancel: (jobId) => solverJobs.cancel(jobId),
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
  };
}
