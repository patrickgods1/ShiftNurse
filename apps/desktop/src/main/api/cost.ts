/** A period's priced schedule against its budget. */

import {
  compareToBudget,
  costSchedule,
  type Id,
  type IsoDate,
  priceDayOfEvents,
  type ScheduleCost,
  type SchedulePeriod,
  type ScheduleView,
} from '@shiftnurse/core';
import {
  clearBudget,
  costContext,
  createDifferential,
  createOvertimeRule,
  createPayRate,
  type DbLike,
  dayOfPayEventsOf,
  deleteDifferential,
  deleteOvertimeRule,
  deletePayRate,
  getBudget,
  getNurse,
  getPaySettings,
  latestPayConfigSnapshot,
  listDayOfPayEvents,
  listDifferentialsForUnit,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
  repricePeriod,
  rosterForPeriod,
  type ShiftNurseDb,
  savePaySettings,
  setBudget,
  transact,
  updateDifferential,
  updateOvertimeRule,
  updatePayRate,
} from '@shiftnurse/db';
import type { PeriodCostReport, ShiftNurseApi } from '../../shared/api.js';

import { ACTOR, periodOrThrow, ruleSetFor, scheduleViewFor } from './context.js';

export function costReport(db: DbLike, periodId: Id): PeriodCostReport {
  const period = periodOrThrow(db, periodId);
  // Weekly overtime can straddle the period boundary just as the rest rules do.
  return costReportForView(
    db,
    period,
    scheduleViewFor(db, period, { lookback: true, floated: 'worked' }),
  );
}

/** A period's cost over a view the caller built — the draft, or a candidate being previewed. */
export function costReportForView(
  db: DbLike,
  period: SchedulePeriod,
  schedule: ScheduleView,
): PeriodCostReport {
  // The period's own snapshot: the weekend definition and work week it was solved under.
  const ruleSet = ruleSetFor(db, period);
  // Read once and handed on, so the schedule, the day-of events and the "priced under" line are
  // all priced from the same kept configuration (a draft has none: it is priced live). The whole
  // snapshot rather than `payConfigFor`, because the report says when it was taken and why.
  const kept = period.status === 'draft' ? undefined : latestPayConfigSnapshot(db, period.id);
  const ctx = costContext(db, period.unitId, ruleSet, period, kept?.config);
  const cost = costSchedule(schedule, ctx);
  const budget = getBudget(db, period.id);
  // Beside the schedule's cost, never in it. A floated-in nurse's missed break is this unit's pay.
  const events = dayOfPayEventsOf(
    listDayOfPayEvents(db, period.unitId, period.startDate, period.endDate),
  );
  // Every nurse an event names, not only this period's roster: one who has since moved to another
  // unit still has her missed break on this unit's books, and core refuses a nurse it was not given.
  const nurses = rosterForPeriod(db, period);
  const known = new Set(nurses.map((n) => n.id));
  for (const { nurseId } of events) {
    if (known.has(nurseId)) continue;
    const nurse = getNurse(db, nurseId);
    if (!nurse) {
      throw new Error(`A day-of pay event names a nurse who was not passed in: ${nurseId}`);
    }
    known.add(nurseId);
    nurses.push(nurse);
  }
  const settings = kept ? kept.config.paySettings : getPaySettings(db, period.unitId);
  const dayOf = priceDayOfEvents(events, ctx, nurses, {
    callBackMinimumHours: settings.callBackMinimumHours,
    breakPremiumRate: settings.breakPremiumRate,
    regularRateFor: regularRateLookup(cost),
  });
  return {
    period,
    cost,
    budget,
    variance: budget ? compareToBudget(cost.totals.total, budget.targetDollars) : undefined,
    dayOf,
    pricedUnder: kept
      ? { takenAt: kept.takenAt, ...(kept.reason !== undefined && { reason: kept.reason }) }
      : undefined,
  };
}

/**
 * The regular rate a missed break on a date is paid at: core's `regularRate` of the nurse's shift
 * dated that day (shifts are dated by start day, and core has already placed each in the window its
 * start lies in, which a date alone cannot do under a week starting at a time of day). No shift
 * that day, no rate: core then pays the base rate.
 */
function regularRateLookup(cost: ScheduleCost): (nurseId: Id, date: IsoDate) => number | undefined {
  const byDay = new Map<string, number>();
  for (const a of cost.assignments) {
    if (a.regularRate === undefined) continue;
    const key = `${a.nurseId}|${a.date}`;
    // Two shifts on one date can sit in different windows (a Saturday day and the night that
    // opens the next week). The event does not say which shift the break was missed on, and a
    // break premium must never be underpaid, so the higher rate wins.
    byDay.set(key, Math.max(byDay.get(key) ?? 0, a.regularRate));
  }
  return (nurseId, date) => byDay.get(`${nurseId}|${date}`);
}

export function setPeriodBudget(db: ShiftNurseDb, periodId: Id, targetDollars: number) {
  return transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    return setBudget(tx, period.unitId, periodId, targetDollars, ACTOR);
  });
}

export function clearPeriodBudget(db: ShiftNurseDb, periodId: Id): void {
  transact(db, (tx) => {
    periodOrThrow(tx, periodId);
    clearBudget(tx, periodId, ACTOR);
  });
}

/** Pay configuration and the period cost report; every write audited in one transaction. */
export function costApi(db: ShiftNurseDb): ShiftNurseApi['cost'] {
  return {
    payRates: (unitId) => listPayRatesForUnit(db, unitId),
    createPayRate: (input) => transact(db, (tx) => createPayRate(tx, input, ACTOR)),
    updatePayRate: (id, patch) => transact(db, (tx) => updatePayRate(tx, id, patch, ACTOR)),
    deletePayRate: (id) => transact(db, (tx) => deletePayRate(tx, id, ACTOR)),
    differentials: (unitId) => listDifferentialsForUnit(db, unitId),
    createDifferential: (input) => transact(db, (tx) => createDifferential(tx, input, ACTOR)),
    updateDifferential: (id, patch) =>
      transact(db, (tx) => updateDifferential(tx, id, patch, ACTOR)),
    deleteDifferential: (id) => transact(db, (tx) => deleteDifferential(tx, id, ACTOR)),
    overtimeRules: (unitId) => listOvertimeRulesForUnit(db, unitId),
    createOvertimeRule: (input) => transact(db, (tx) => createOvertimeRule(tx, input, ACTOR)),
    updateOvertimeRule: (id, patch) =>
      transact(db, (tx) => updateOvertimeRule(tx, id, patch, ACTOR)),
    deleteOvertimeRule: (id) => transact(db, (tx) => deleteOvertimeRule(tx, id, ACTOR)),
    report: (periodId) => costReport(db, periodId),
    setBudget: (periodId, targetDollars) => setPeriodBudget(db, periodId, targetDollars),
    clearBudget: (periodId) => clearPeriodBudget(db, periodId),
    paySettings: (unitId) => getPaySettings(db, unitId),
    savePaySettings: (unitId, settings) =>
      transact(db, (tx) => savePaySettings(tx, unitId, settings, ACTOR)),
    reprice: (periodId, reason) => transact(db, (tx) => repricePeriod(tx, periodId, ACTOR, reason)),
  };
}
