/** A period's priced schedule against its budget. */

import { compareToBudget, costSchedule, type Id } from '@shiftnurse/core';
import { costContext, type DbLike, getBudget, setBudget } from '@shiftnurse/db';
import type { PeriodCostReport } from '../../shared/api.js';

import { ACTOR, periodOrThrow, ruleSetFor, scheduleViewFor } from './context.js';

export function costReport(db: DbLike, periodId: Id): PeriodCostReport {
  const period = periodOrThrow(db, periodId);
  // The period's own snapshot: the weekend definition and work week it was solved under.
  const ruleSet = ruleSetFor(db, period);
  // Weekly overtime can straddle the period boundary just as the rest rules do.
  const schedule = scheduleViewFor(db, period, { lookback: true });
  const cost = costSchedule(schedule, costContext(db, period.unitId, ruleSet));
  const budget = getBudget(db, periodId);
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
