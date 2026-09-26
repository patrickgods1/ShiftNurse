/**
 * The loaders every domain module shares: "this id, or a loud error", the period's own rule-set
 * snapshot, and the one way to build a period's schedule view.
 *
 * Before these existed, each handler in `main/api.ts` re-wrote "get the period, throw if it is
 * missing" and built its own `ScheduleView` — and whether that view carried the lookback tail
 * differed silently between validation, cost, fairness and publish. `scheduleViewFor` makes the
 * choice a named argument at every call site.
 */

import {
  type Assignment,
  type ConflictInput,
  type CounterContext,
  defaultRuleSet,
  type Id,
  type IsoDate,
  type Nurse,
  type RuleSet,
  type SchedulePeriod,
  ScheduleView,
  type ShiftType,
  type Unit,
} from '@shiftnurse/core';
import {
  type DbLike,
  getAssignment,
  getBudget,
  getLatestRuleSet,
  getPeriod,
  getRuleSet,
  getUnit,
  listAssignmentsForPeriod,
  listHolidaysForUnit,
  listNursesForUnit,
  listPreferencesForUnit,
  listShiftTypesForUnit,
  listTimeOffForUnit,
  loadPeriodInput,
  priorAssignmentsBefore,
} from '@shiftnurse/db';

/**
 * v1 has one user, the manager, and no login. Every audit entry is attributed to this actor;
 * when accounts arrive this becomes the session's user and nothing else changes.
 */
export const ACTOR = 'manager';

/**
 * Days of the previous published schedule a view carries. Rest and consecutive-shift rules
 * look back across the period boundary, so a Monday shift is judged against the Sunday night
 * before it even though that Sunday belongs to an earlier period.
 */
export const LOOKBACK_DAYS = 14;

export function unitOrThrow(db: DbLike, unitId: Id): Unit {
  const unit = getUnit(db, unitId);
  if (!unit) throw new Error(`Unknown unit ${unitId}`);
  return unit;
}

export function periodOrThrow(db: DbLike, periodId: Id): SchedulePeriod {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  return period;
}

/**
 * The period's own rule-set snapshot, never "latest": a published schedule must stay judged by
 * the rules it was solved under, or tightening a rest rule next month would retroactively make
 * last month's schedule non-compliant.
 */
export function ruleSetFor(db: DbLike, period: SchedulePeriod): RuleSet {
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${period.id} cites unknown rule set ${period.ruleSetId}`);
  return ruleSet;
}

export function assignmentOrThrow(db: DbLike, assignmentId: Id): Assignment {
  const existing = getAssignment(db, assignmentId);
  if (!existing) throw new Error(`Assignment ${assignmentId} not found`);
  return existing;
}

export function latestRuleSetOrDefault(db: DbLike, unitId: Id): RuleSet {
  return getLatestRuleSet(db, unitId) ?? defaultRuleSet(unitId);
}

export interface ScheduleViewOptions {
  /**
   * Carry the lookback tail. On for anything judging rules, hours or overtime across the period
   * boundary (validation, cost, alerts, output); off for counting what this period itself
   * scheduled (fairness counters, the ledger written at publish).
   */
  lookback: boolean;
  /** Already loaded by the caller; loaded here otherwise. */
  nurses?: Nurse[];
  shiftTypes?: ShiftType[];
}

export function scheduleViewFor(
  db: DbLike,
  period: SchedulePeriod,
  options: ScheduleViewOptions,
): ScheduleView {
  return new ScheduleView({
    period,
    assignments: listAssignmentsForPeriod(db, period.id),
    ...(options.lookback
      ? {
          priorAssignments: priorAssignmentsBefore(
            db,
            period.unitId,
            period.startDate,
            LOOKBACK_DAYS,
          ),
        }
      : {}),
    nurses: options.nurses ?? listNursesForUnit(db, period.unitId),
    shiftTypes: options.shiftTypes ?? listShiftTypesForUnit(db, period.unitId),
  });
}

/** Everything `deriveCounters` needs for a unit under a given rule set, loaded once. */
export function counterContext(db: DbLike, unitId: Id, ruleSet: RuleSet): CounterContext {
  return {
    unit: unitOrThrow(db, unitId),
    holidayDates: new Set<IsoDate>(listHolidaysForUnit(db, unitId).map((h) => h.date)),
    weekendDefinition: ruleSet.weekendDefinition,
    preferences: listPreferencesForUnit(db, unitId),
    timeOff: listTimeOffForUnit(db, unitId),
  };
}

/**
 * The same rows the solver sees, plus the budget, for conflict detection. Analysis is
 * read-only, so a published period is fine here — the manager may want to know what a
 * late approval did to last week's schedule — while *applying* a resolution is refused for
 * anything but a draft inside `applyResolution` itself.
 */
export function buildConflictInput(db: DbLike, periodId: Id): ConflictInput {
  const period = periodOrThrow(db, periodId);
  const budget = getBudget(db, periodId);
  return { ...loadPeriodInput(db, period), ...(budget ? { budget } : {}) };
}
