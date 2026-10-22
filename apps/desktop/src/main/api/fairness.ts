/** Fairness: a period's report, the unit's trend, and turning imported history into ledger rows. */

import {
  type Assignment,
  addDays,
  type BurdenCounters,
  compareDates,
  deriveCounters,
  deriveOccurrences,
  type FairnessLedgerEntry,
  groupIntoPayPeriods,
  type HistoricalShiftRow,
  type Id,
  type IsoDate,
  type Nurse,
  type SchedulePeriod,
  ScheduleView,
  type ShiftType,
  scoreFairness,
  today,
} from '@shiftnurse/core';
import {
  type DbLike,
  getPeriod,
  importHistoricalLedger,
  LEDGER_LOOKBACK_DAYS,
  ledgerHistory,
  ledgerSince,
  listNursesForUnit,
  listPreferencesForUnit,
  listShiftTypesForUnit,
  periodLedgerRows,
  type ShiftNurseDb,
  transact,
  type UpsertFairnessLedgerInput,
} from '@shiftnurse/db';
import type { FairnessTrendPoint, HistoryImportSummary, ShiftNurseApi } from '../../shared/api.js';

import {
  ACTOR,
  counterContext,
  latestRuleSetOrDefault,
  periodOrThrow,
  ruleSetFor,
  scheduleViewFor,
  unitOrThrow,
} from './context.js';

export function fairnessReport(db: DbLike, periodId: Id) {
  const period = periodOrThrow(db, periodId);
  // Same reasoning as validation: the weights and weekend definition the period was created
  // under, not whatever the Rules screen says today.
  const ruleSet = ruleSetFor(db, period);
  const nurses = listNursesForUnit(db, period.unitId);
  // No lookback: the counters are what *this* period scheduled; history comes from the ledger.
  // The view carries floated-in nurses too (their shifts here are on the schedule); the score is
  // over the unit's own nurses, whose burden history this unit keeps.
  const schedule = scheduleViewFor(db, period, { lookback: false, floated: 'worked' });
  const ctx = counterContext(db, period.unitId, ruleSet, period);
  // Only rows strictly before this period: if this period was published before, its own
  // ledger row would otherwise be counted as history *and* as the current draft.
  return scoreFairness({
    nurses: nurses.filter((n) => n.active),
    current: deriveCounters(schedule, ctx),
    occurrences: deriveOccurrences(schedule, ctx),
    history: ledgerHistory(db, period.unitId, period.startDate),
    scope: {
      asOf: period.startDate,
      periodDays: schedule.dates.length,
      payPeriodDays: ctx.unit.payPeriodDays,
    },
    preferences: ctx.preferences,
    weights: ruleSet.fairnessWeights,
  });
}

function countersFromEntry(entry: FairnessLedgerEntry): BurdenCounters {
  const { id: _id, nurseId: _nurse, periodId: _period, periodStart: _start, ...counters } = entry;
  return counters;
}

/**
 * Re-score each ledger period against only the history before it, under the weights it was
 * judged by (imported periods, which have none, use the unit's latest), over the nurses with a
 * row in it — so the trend shows whether the unit is getting fairer, not today's rules and
 * today's roster smeared over the past. A leaver is still in the periods she worked; a nurse
 * hired since is absent from the ones before her.
 */
export function fairnessTrend(db: DbLike, unitId: Id): FairnessTrendPoint[] {
  const entries = ledgerSince(db, unitId, addDays(today(), -LEDGER_LOOKBACK_DAYS));
  const nurses = listNursesForUnit(db, unitId);
  const latestWeights = latestRuleSetOrDefault(db, unitId).fairnessWeights;
  const preferences = listPreferencesForUnit(db, unitId);
  const { payPeriodDays } = unitOrThrow(db, unitId);

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
    const periodDays = rows[0]!.periodDays;
    if (rows.some((r) => r.periodDays !== periodDays)) {
      throw new Error(`Fairness history for ${periodStart} mixes period lengths.`);
    }
    // getPeriod, not periodOrThrow: an imported period's id is synthetic and has no row.
    const period = getPeriod(db, periodId);
    const weights = period ? ruleSetFor(db, period).fairnessWeights : latestWeights;
    const present = new Set(rows.map((r) => r.nurseId));
    const report = scoreFairness({
      nurses: nurses.filter((n) => present.has(n.id)),
      current: new Map(rows.map((r) => [r.nurseId, countersFromEntry(r)])),
      history: entries.filter((e) => compareDates(e.periodStart, periodStart) < 0),
      scope: { asOf: periodStart, periodDays, payPeriodDays },
      preferences,
      weights,
    });
    const scores: Record<Id, number> = {};
    for (const s of report.scores) scores[s.nurseId] = s.score;
    return { periodId, periodStart, scores, gini: report.distribution.score.gini };
  });
}

/**
 * Turn imported shifts into ledger rows by running each pay period through the same
 * `deriveCounters` a published period will use, so imported history and app-generated history
 * are counted identically — a weekend is a weekend under the same definition either way.
 */
export function importHistory(
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
    // Only active types: a retired one may share its successor's abbreviation, and two active
    // ones sharing it would book the file's shifts under whichever the map saw last.
    const shiftTypeByAbbreviation = new Map<string, ShiftType>();
    for (const s of shiftTypes) {
      if (!s.active) continue;
      const key = s.abbreviation.trim().toLowerCase();
      if (shiftTypeByAbbreviation.has(key)) {
        throw new Error(
          `The abbreviation ${s.abbreviation.trim()} belongs to more than one active shift type on this unit, so the file cannot say which it means. Rename or retire one first.`,
        );
      }
      shiftTypeByAbbreviation.set(key, s);
    }
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
        const shiftType = shiftTypeByAbbreviation.get(r.shiftAbbreviation.trim().toLowerCase());
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
      // Only nurses who appear in this period's file: there is no reliable roster for a period
      // that predates the app, and a nurse missing from it may not have been hired yet.
      entries.push(...periodLedgerRows(schedule, ctx, { includeAvailableHomeNurses: false }));
    }
    const result = importHistoricalLedger(tx, unitId, entries, ACTOR);
    return {
      periodsImported: periods.length,
      entriesWritten: result.written,
      entriesReplaced: result.replaced,
    };
  });
}

/** The fairness resource, less the history file picker, which is Electron's (`api.ts`). */
export function fairnessApi(
  db: ShiftNurseDb,
): Omit<ShiftNurseApi['fairness'], 'pickHistoryImportFile'> {
  return {
    report: (periodId) => fairnessReport(db, periodId),
    history: (unitId) => ledgerSince(db, unitId, addDays(today(), -LEDGER_LOOKBACK_DAYS)),
    trend: (unitId) => fairnessTrend(db, unitId),
    importHistory: (unitId, rows) => importHistory(db, unitId, rows),
  };
}
