/**
 * A period's priced schedule against its budget, and where comp time is on, the overtime banked
 * as comp time instead of paid.
 */

import {
  type CompTimeElection,
  compareDates,
  compareToBudget,
  costSchedule,
  type Id,
  type IsoDate,
  priceDayOfEvents,
  type ScheduleCost,
  type SchedulePeriod,
  type ScheduleView,
  today,
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
  listAssignmentsForPeriod,
  listCompTimeCreditsForPeriod,
  listCompTimeElectionsForUnit,
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
import type { PaySettings, PeriodCostReport, ShiftNurseApi } from '../../shared/api.js';
import { ACTOR, periodOrThrow, ruleSetFor, scheduleViewFor } from './context.js';

/** `today` is the manager's date, passed in by the IPC layer: it decides whether comp time can be banked. */
export function costReport(db: DbLike, periodId: Id, today: IsoDate): PeriodCostReport {
  const period = periodOrThrow(db, periodId);
  // Weekly overtime can straddle the period boundary just as the rest rules do.
  return costReportForView(
    db,
    period,
    scheduleViewFor(db, period, { lookback: true, floated: 'worked' }),
    today,
  );
}

/** A period's cost over a view the caller built — the draft, or a candidate being previewed. */
export function costReportForView(
  db: DbLike,
  period: SchedulePeriod,
  schedule: ScheduleView,
  today: IsoDate,
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
  const compTime = compTimeSummary(db, period, settings.compTime, today, cost.assignments);
  return {
    period,
    // Banked hours change no dollars here: payroll pays them later as leave taken, and this
    // report prices the schedule as worked.
    cost,
    budget,
    variance: budget ? compareToBudget(cost.totals.total, budget.targetDollars) : undefined,
    dayOf,
    pricedUnder: kept
      ? { takenAt: kept.takenAt, ...(kept.reason !== undefined && { reason: kept.reason }) }
      : undefined,
    ...(compTime ? { compTime } : {}),
  };
}

/**
 * The period's banked comp time, present when the settings it is priced under have comp time on
 * or it already holds credits (a later switch-off must not hide what was banked).
 */
function compTimeSummary(
  db: DbLike,
  period: SchedulePeriod,
  setting: PaySettings['compTime'],
  today: IsoDate,
  assignments: ScheduleCost['assignments'],
): PeriodCostReport['compTime'] {
  const credits = listCompTimeCreditsForPeriod(db, period.id);
  if (setting === null && credits.length === 0) return undefined;
  return {
    credits: credits.map(({ nurseId, overtimeHours, creditedHours, paidOvertimeHours }) => ({
      nurseId,
      overtimeHours,
      creditedHours,
      paidOvertimeHours,
    })),
    bankedOvertimeHours: credits.reduce((sum, c) => sum + c.overtimeHours - c.paidOvertimeHours, 0),
    canBank:
      setting !== null &&
      period.status !== 'draft' &&
      compareDates(period.endDate, today) < 0 &&
      credits.length === 0 &&
      electedOvertimeMinutes(db, period, assignments).size > 0,
  };
}

/** Inclusive at both ends; an election with no end runs on. */
const covers = (e: CompTimeElection, date: IsoDate) =>
  compareDates(e.startsOn, date) <= 0 &&
  (e.endsOn === undefined || compareDates(date, e.endsOn) <= 0);

/**
 * Each nurse's overtime this period dated inside one of her comp elections on the unit, in whole
 * minutes, nurses with none left out: what banking credits, and so what `canBank` asks about. One
 * definition, so the button is never offered for a period that would bank nothing.
 */
export function electedOvertimeMinutes(
  db: DbLike,
  period: SchedulePeriod,
  assignments: ScheduleCost['assignments'],
): Map<Id, number> {
  const elections = new Map<Id, CompTimeElection[]>();
  for (const e of listCompTimeElectionsForUnit(db, period.unitId)) {
    elections.set(e.nurseId, [...(elections.get(e.nurseId) ?? []), e]);
  }
  // Core reports only the period's own shifts, never the lookback tail it prices them against;
  // checked here as well, since a tail shift's overtime belongs to the period that holds it.
  const own = new Set(listAssignmentsForPeriod(db, period.id).map((a) => a.id));
  const minutes = new Map<Id, number>();
  for (const a of assignments) {
    if (!own.has(a.assignmentId) || a.overtimeHours === 0) continue;
    if (!(elections.get(a.nurseId) ?? []).some((e) => covers(e, a.date))) continue;
    // Summed in whole minutes, as core attributes them, so 0.1 + 0.2 never banks 0.30000000004.
    minutes.set(a.nurseId, (minutes.get(a.nurseId) ?? 0) + Math.round(a.overtimeHours * 60));
  }
  for (const [nurseId, total] of minutes) if (total <= 0) minutes.delete(nurseId);
  return minutes;
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

/**
 * Pay configuration and the period cost report; every write audited in one transaction. Banking
 * comp time is wired beside it in `api.ts`: it prices the period through this module, so living
 * here would make the two import each other.
 */
export function costApi(db: ShiftNurseDb): Omit<ShiftNurseApi['cost'], 'bankCompTime'> {
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
    report: (periodId) => costReport(db, periodId, today()),
    setBudget: (periodId, targetDollars) => setPeriodBudget(db, periodId, targetDollars),
    clearBudget: (periodId) => clearPeriodBudget(db, periodId),
    paySettings: (unitId) => getPaySettings(db, unitId),
    savePaySettings: (unitId, settings) =>
      transact(db, (tx) => savePaySettings(tx, unitId, settings, ACTOR)),
    reprice: (periodId, reason) => transact(db, (tx) => repricePeriod(tx, periodId, ACTOR, reason)),
  };
}
