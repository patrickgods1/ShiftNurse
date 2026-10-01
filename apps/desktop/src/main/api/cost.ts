/** A period's priced schedule against its budget. */

import {
  compareToBudget,
  costSchedule,
  type Id,
  type SchedulePeriod,
  type ScheduleView,
} from '@shiftnurse/core';
import {
  costContext,
  createDifferential,
  createOvertimeRule,
  createPayRate,
  type DbLike,
  deleteDifferential,
  deleteOvertimeRule,
  deletePayRate,
  getBudget,
  listDifferentialsForUnit,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
  type ShiftNurseDb,
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
  return costReportForView(db, period, scheduleViewFor(db, period, { lookback: true }));
}

/** A period's cost over a view the caller built — the draft, or a candidate being previewed. */
export function costReportForView(
  db: DbLike,
  period: SchedulePeriod,
  schedule: ScheduleView,
): PeriodCostReport {
  // The period's own snapshot: the weekend definition and work week it was solved under.
  const ruleSet = ruleSetFor(db, period);
  const cost = costSchedule(schedule, costContext(db, period.unitId, ruleSet));
  const budget = getBudget(db, period.id);
  return {
    period,
    cost,
    budget,
    variance: budget ? compareToBudget(cost.totals.total, budget.targetDollars) : undefined,
  };
}

export function setPeriodBudget(db: ShiftNurseDb, periodId: Id, targetDollars: number) {
  return transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    return setBudget(tx, period.unitId, periodId, targetDollars, ACTOR);
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
  };
}
