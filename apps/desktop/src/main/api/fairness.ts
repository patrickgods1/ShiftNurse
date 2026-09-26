/** Fairness: a period's report, the unit's trend, and turning imported history into ledger rows. */

import {
  type Assignment,
  addDays,
  type BurdenCounters,
  compareDates,
  deriveCounters,
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
  importHistoricalLedger,
  LEDGER_LOOKBACK_DAYS,
  ledgerHistory,
  ledgerSince,
  listActiveNursesForUnit,
  listNursesForUnit,
  listPreferencesForUnit,
  listShiftTypesForUnit,
  type ShiftNurseDb,
  transact,
  type UpsertFairnessLedgerInput,
} from '@shiftnurse/db';
import type { FairnessTrendPoint, HistoryImportSummary } from '../../shared/api.js';

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
  const schedule = scheduleViewFor(db, period, { lookback: false, nurses });
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
export function fairnessTrend(db: DbLike, unitId: Id): FairnessTrendPoint[] {
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
