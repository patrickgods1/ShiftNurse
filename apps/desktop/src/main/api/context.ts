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
  dateInRange,
  defaultRuleSet,
  type Id,
  type IsoDate,
  isFloatedOff,
  type Nurse,
  type RuleSet,
  type SchedulePeriod,
  ScheduleView,
  type ShiftType,
  type Unit,
} from '@shiftnurse/core';
import {
  counterContextFor,
  type DbLike,
  getAssignment,
  getBudget,
  getLatestRuleSet,
  getPeriod,
  getRuleSet,
  getUnit,
  listAssignmentsForPeriod,
  listPeriodsForUnit,
  listShiftTypesForUnit,
  loadPeriodInput,
  PRIOR_ASSIGNMENT_LOOKBACK_DAYS,
  periodTailFor,
  rosterForPeriod,
  splitFloatedOff,
  uniqueById,
} from '@shiftnurse/db';

/**
 * v1 has one user, the manager, and no login. Every audit entry is attributed to this actor;
 * when accounts arrive this becomes the session's user and nothing else changes.
 */
export const ACTOR = 'manager';

/**
 * Days of the previous published schedule a view carries: the loader's own tail, so the grid
 * judges a period exactly as Generate does. Rest and consecutive-shift rules look back across the
 * period boundary, so a Monday shift is judged against the Sunday night before it even though
 * that Sunday belongs to an earlier period.
 */
export const LOOKBACK_DAYS = PRIOR_ASSIGNMENT_LOOKBACK_DAYS;

export function unitOrThrow(db: DbLike, unitId: Id): Unit {
  const unit = getUnit(db, unitId);
  if (!unit) throw new Error('That unit no longer exists. Reload the app.');
  return unit;
}

export function periodOrThrow(db: DbLike, periodId: Id): SchedulePeriod {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error('That schedule period no longer exists. Reload the page.');
  return period;
}

/**
 * The period's own rule-set snapshot, never "latest": a published schedule must stay judged by
 * the rules it was solved under, or tightening a rest rule next month would retroactively make
 * last month's schedule non-compliant.
 */
export function ruleSetFor(db: DbLike, period: SchedulePeriod): RuleSet {
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet)
    throw new Error(
      `${period.name} cites a rule set that is missing from the database. Restore a backup (Settings › Backups).`,
    );
  return ruleSet;
}

export function assignmentOrThrow(db: DbLike, assignmentId: Id): Assignment {
  const existing = getAssignment(db, assignmentId);
  if (!existing)
    throw new Error(
      'That shift was not found; it may have been moved or removed. Refresh the page.',
    );
  return existing;
}

/** A unit with no saved rules is judged by the defaults, shown as of now (core reads no clock). */
export function latestRuleSetOrDefault(db: DbLike, unitId: Id): RuleSet {
  return getLatestRuleSet(db, unitId) ?? defaultRuleSet(unitId, undefined, Date.now());
}

export interface ScheduleViewOptions {
  /**
   * Carry the lookback tail. On for anything judging rules, hours or overtime across the period
   * boundary (validation, cost, alerts, output); off for counting what this period itself
   * scheduled (fairness counters, the ledger written at publish).
   */
  lookback: boolean;
  /**
   * How a shift the nurse was floated off (D20) reads. Rules judge it as busy time; everything
   * else counts it as the real shift. The wrong choice either puts her on this unit's floor for
   * validation or drops her pay from cost, so every caller decides: rules → `'busy'`, everything
   * else → `'worked'`.
   *
   * - `'busy'`: for judging rules (grid validation). The period's floated-off rows, always read
   *   from the database, ride in the tail as `floatedOff` busy time; any floated row in
   *   `assignments` is dropped.
   * - `'worked'`: for counting and pricing (cost, alerts, fairness, ledger, print). The period's
   *   floated-off rows are in-period with their real types, which the view's floor queries skip;
   *   with `assignments` (a candidate) they are appended after its own rows, minus any duplicate id.
   */
  floated: 'busy' | 'worked';
  /** Already loaded by the caller; loaded here otherwise. */
  nurses?: Nurse[];
  shiftTypes?: ShiftType[];
  /** In place of the period's own rows: a Generate candidate being previewed. */
  assignments?: Assignment[];
}

export function scheduleViewFor(
  db: DbLike,
  period: SchedulePeriod,
  options: ScheduleViewOptions,
): ScheduleView {
  const nurses = options.nurses ?? rosterForPeriod(db, period);
  // The tail is Generate's own (`periodTailFor`): this unit's earlier shifts, and busy time on
  // other units or on another posted schedule of this unit, judged by rest, overlap and hours,
  // never flagged or drawn as this period's chips (the grid lists `periods.assignments`, not the
  // view). A counting view (no lookback) leaves it out: none of it is this period's work.
  const tail = options.lookback ? periodTailFor(db, period, nurses) : undefined;
  const shiftTypes = options.shiftTypes ?? listShiftTypesForUnit(db, period.unitId);
  const stored = listAssignmentsForPeriod(db, period.id);
  if (options.floated === 'busy') {
    // Busy time in every judging view, lookback or not: her hours that day are in-period dates.
    const { busy } = splitFloatedOff(stored, shiftTypes);
    const prior = [...(tail?.priorAssignments ?? []), ...busy.assignments];
    return new ScheduleView({
      period,
      assignments: (options.assignments ?? stored).filter((a) => !isFloatedOff(a)),
      ...(prior.length > 0 || tail ? { priorAssignments: prior } : {}),
      nurses,
      shiftTypes: uniqueById([...shiftTypes, ...(tail?.shiftTypes ?? []), ...busy.shiftTypes]),
    });
  }
  // A candidate never holds a floated row (the solver never sees one as its own), but they are
  // the period's real work, so they ride along.
  let assignments = stored;
  if (options.assignments) {
    const own = new Set(options.assignments.map((a) => a.id));
    assignments = [
      ...options.assignments,
      ...stored.filter((a) => isFloatedOff(a) && !own.has(a.id)),
    ];
  }
  return new ScheduleView({
    period,
    assignments,
    ...(tail ? { priorAssignments: tail.priorAssignments } : {}),
    nurses,
    shiftTypes: uniqueById([...shiftTypes, ...(tail?.shiftTypes ?? [])]),
  });
}

/** Everything `deriveCounters` needs for a unit under a given rule set, loaded once. */
export function counterContext(
  db: DbLike,
  unitId: Id,
  ruleSet: RuleSet,
  // The period being counted; history import counts many periods, so it passes none and reads all.
  period?: SchedulePeriod,
): CounterContext {
  return counterContextFor(db, unitId, ruleSet.weekendDefinition, period);
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

const PERIOD_STATUS_PRIORITY: Record<SchedulePeriod['status'], number> = {
  published: 0,
  draft: 1,
  archived: 2,
};

/**
 * The period whose shifts count for a date: published over draft over archived. Periods may
 * overlap (a draft is often laid out before the published one ends), and counting every period's
 * rows for the date would show a draft's proposals as people actually on shift.
 */
export function periodCoveringDate(
  db: DbLike,
  unitId: Id,
  date: IsoDate,
): SchedulePeriod | undefined {
  const covering = listPeriodsForUnit(db, unitId).filter((p) =>
    dateInRange(date, p.startDate, p.endDate),
  );
  covering.sort((a, b) => PERIOD_STATUS_PRIORITY[a.status] - PERIOD_STATUS_PRIORITY[b.status]);
  return covering[0];
}
