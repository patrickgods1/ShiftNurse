/** A period's priced schedule against its budget. */

import {
  compareToBudget,
  costSchedule,
  type Id,
  type SchedulePeriod,
  type ScheduleView,
} from '@shiftnurse/core';
import { costContext, type DbLike, getBudget, setBudget } from '@shiftnurse/db';
import type { PeriodCostReport } from '../../shared/api.js';

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

export function setPeriodBudget(db: DbLike, periodId: Id, targetDollars: number) {
  const period = periodOrThrow(db, periodId);
  return setBudget(db, period.unitId, periodId, targetDollars, ACTOR);
}
