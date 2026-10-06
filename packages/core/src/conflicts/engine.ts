/**
 * The shared machinery behind conflict detection and resolution simulation.
 *
 * ## Why one engine
 *
 * Detection asks "what is short right now?"; resolution asks the same question dozens of
 * times about hypothetical schedules ("...and if Priya took Saturday night?"). Both must be
 * answered by exactly the rule set, derived demand, lookback tail and pay context the solver
 * and the grid use, or an option can look legal here and turn a cell red on the grid. The
 * engine builds those indexes once from a `ConflictInput` and lends them to every simulation;
 * what changes between simulations — the assignments and the request statuses — lives in a
 * `SimState`.
 *
 * ## Why simulations are evaluated by scope, not in full
 *
 * A full `evaluateSchedule` over a six-week, 42-nurse period costs ~14ms. Ten conflicts with
 * twenty candidates each would spend three seconds on rule evaluation alone. Every shipped rule
 * declares a scope (`RuleScope`): nurse-scope rules read one nurse's timeline, shift-scope rules
 * read one shift's roster. So a simulation evaluates only the nurses and shifts a change
 * touches, on partial views, exactly as the solver's gate does — the real rules with the real
 * parameters, so a rule added to the registry with a truthful scope is honoured here for free.
 * The staffing measure (`hardShortfall`) is read straight off derived demand, which is what the
 * solver's progress reports and `shortfallsForShift` already do.
 *
 * ## Determinism
 *
 * Nurses are iterated in id order and dates in calendar order; nothing reads the clock. Two
 * runs on the same input produce the same conflicts, the same resolutions and the same scores.
 */

import { DemandTable, NURSE_ROLES } from '../acuity/demand.js';
import { costNurse, costSchedule } from '../cost/cost.js';
import type { AssignmentCost, CostContext } from '../cost/types.js';
import type {
  Assignment,
  Id,
  Nurse,
  RatioRole,
  ShiftType,
  TimeOffRequest,
} from '../domain/entities.js';
import { addDays, dateInRange, datesInRange, type IsoDate } from '../domain/time.js';
import { FairnessEvaluator } from '../fairness/evaluator.js';
import { deriveCounters } from '../fairness/ledger.js';
import type { BurdenCounters, CounterContext } from '../fairness/types.js';
import { type MaxHoursParams, maxHoursRule } from '../rules/hours-rules.js';
import {
  buildRuleContext,
  evaluatePrepared,
  evaluateSchedule,
  type PreparedRule,
  prepareRules,
  resolveConfigs,
  ruleIdsByScope,
} from '../rules/registry.js';
import type { EvaluationResult, RuleContext, Violation } from '../rules/types.js';
import { containingDate, coveringShift } from '../schedule/cover.js';
import { overlappingShifts } from '../schedule/overlap.js';
import { ScheduleView } from '../schedule/view.js';
import type { ConflictInput } from './types.js';

/** One (date, shift type, role) cell with a hard minimum or soft target, in calendar order. */
export interface Slot {
  date: IsoDate;
  shiftType: ShiftType;
  /** A role, or `licensed` for the RN + LPN pool a licensed ratio requires. */
  role: RatioRole;
  min: number;
  target: number;
  /** On a `licensed` slot: the RNs the share needs, which the pool counts only once. */
  rnMin?: number;
}

export interface FairnessSnapshot {
  /** Unit mean of the per-nurse composite over comparable nurses, 0–100. */
  mean: number;
  byNurse: ReadonlyMap<Id, number>;
}

export class ConflictEngine {
  readonly input: ConflictInput;
  /** Sorted by id so every iteration order is independent of row order. */
  readonly nurses: readonly Nurse[];
  readonly activeNurses: readonly Nurse[];
  readonly nursesById: ReadonlyMap<Id, Nurse>;
  readonly timeOffById: ReadonlyMap<Id, TimeOffRequest>;
  readonly shiftTypes: readonly ShiftType[];
  readonly shiftTypesById: ReadonlyMap<Id, ShiftType>;
  readonly dates: readonly IsoDate[];
  readonly demand: DemandTable;
  readonly slots: readonly Slot[];
  /** The slots of one date × shift type, keyed `date|shiftTypeId`, for re-pricing a changed cell. */
  readonly slotsByCell: ReadonlyMap<string, readonly Slot[]>;
  readonly nurseRuleIds: readonly string[];
  readonly shiftRuleIds: readonly string[];
  /** Resolved once per engine; every simulated state evaluates against these. */
  readonly nurseRules: readonly PreparedRule[];
  readonly shiftRules: readonly PreparedRule[];
  readonly maxHoursParams: MaxHoursParams;
  readonly costCtx: CostContext | undefined;
  readonly counterCtx: Omit<CounterContext, 'timeOff'>;
  /** Every candidate fix is priced for fairness; history and weights are fixed per analysis. */
  readonly fairnessEvaluator: FairnessEvaluator;
  private readonly baseCtx: RuleContext;

  constructor(input: ConflictInput) {
    this.input = input;
    this.nurses = [...input.nurses].sort((a, b) => a.id.localeCompare(b.id));
    this.activeNurses = this.nurses.filter((n) => n.active);
    this.fairnessEvaluator = new FairnessEvaluator({
      nurses: this.activeNurses,
      history: input.ledgerHistory,
      weights: input.ruleSet.fairnessWeights,
    });
    this.nursesById = new Map(this.nurses.map((n) => [n.id, n]));
    // Built once so per-request and per-candidate lookups are O(1): `.find` inside those loops
    // made the analysis quadratic on a busy period, and it runs on every Requests view.
    this.timeOffById = new Map(input.timeOff.map((r) => [r.id, r]));
    this.shiftTypes = [...input.shiftTypes].sort((a, b) => a.sortOrder - b.sortOrder);
    this.shiftTypesById = new Map(this.shiftTypes.map((s) => [s.id, s]));
    this.dates = datesInRange(input.period.startDate, input.period.endDate);
    this.demand = new DemandTable(input.demand);
    this.baseCtx = this.contextFor(input.timeOff);
    // Hard and soft: simulations diff both.
    this.nurseRuleIds = ruleIdsByScope(input.ruleSet, 'nurse', { hardOnly: false });
    this.shiftRuleIds = ruleIdsByScope(input.ruleSet, 'shift', { hardOnly: false });
    this.nurseRules = prepareRules(input.ruleSet, this.nurseRuleIds);
    this.shiftRules = prepareRules(input.ruleSet, this.shiftRuleIds);

    const configs = resolveConfigs(input.ruleSet);
    this.maxHoursParams = (configs.find((c) => c.ruleId === maxHoursRule.id)?.params ??
      maxHoursRule.defaultParams) as MaxHoursParams;

    const slots: Slot[] = [];
    for (const date of this.dates) {
      for (const shiftType of this.shiftTypes) {
        if (!shiftType.active) continue;
        const row = this.demand.get(date, shiftType.id);
        if (!row) continue;
        for (const role of NURSE_ROLES) {
          const { minCount, targetCount } = row.byRole[role];
          if (minCount <= 0 && targetCount <= 0) continue;
          slots.push({ date, shiftType, role, min: minCount, target: targetCount });
        }
        if (row.licensed) {
          const pooled = row.licensed.ratioDerived;
          slots.push({
            date,
            shiftType,
            role: 'licensed',
            min: pooled,
            target: pooled,
            rnMin: row.licensed.minRn,
          });
        }
      }
    }
    this.slots = slots;
    const byCell = new Map<string, Slot[]>();
    for (const slot of slots) {
      const key = cellKey(slot.date, slot.shiftType.id);
      const list = byCell.get(key);
      if (list) list.push(slot);
      else byCell.set(key, [slot]);
    }
    this.slotsByCell = byCell;

    this.costCtx = input.cost
      ? {
          unit: input.unit,
          payRates: input.cost.payRates,
          differentials: input.cost.differentials.filter((d) => d.active),
          overtimeRules: input.cost.overtimeRules.filter((r) => r.active),
          holidayDates: this.baseCtx.holidayDates,
          majorHolidayDates: this.baseCtx.majorHolidayDates,
          weekendDefinition: input.ruleSet.weekendDefinition,
          workWeekStartsOn: this.maxHoursParams.workWeekStartsOn,
          ...(this.maxHoursParams.paidLeaveCountsTowardOvertime
            ? { overtimeLeave: this.baseCtx.paidLeaveByNurse }
            : {}),
        }
      : undefined;
    this.counterCtx = {
      unit: input.unit,
      holidayDates: this.baseCtx.holidayDates,
      weekendDefinition: input.ruleSet.weekendDefinition,
      preferences: input.preferences,
    };
  }

  /** The rule context for a set of requests; the input's own is built once and reused. */
  contextFor(timeOff: readonly TimeOffRequest[]): RuleContext {
    if (this.baseCtx && timeOff === this.input.timeOff) return this.baseCtx;
    return buildRuleContext({
      unit: this.input.unit,
      demand: this.demand,
      nurses: this.nurses,
      shiftTypes: this.shiftTypes,
      timeOff,
      credentials: this.input.credentials,
      nurseCredentials: this.input.nurseCredentials,
      shiftCredentialRequirements: this.input.shiftCredentialRequirements,
      holidays: this.input.holidays,
      weekendDefinition: this.input.ruleSet.weekendDefinition,
      ...(this.input.paidSickCalls ? { paidSickCalls: this.input.paidSickCalls } : {}),
      ...(this.input.incompatibilityGroups
        ? { incompatibilityGroups: this.input.incompatibilityGroups }
        : {}),
      ...(this.input.holidayWork ? { holidayWork: this.input.holidayWork } : {}),
      ...(this.input.overtimeVolunteers
        ? { overtimeVolunteers: this.input.overtimeVolunteers }
        : {}),
      ...(this.input.preceptorships ? { preceptorships: this.input.preceptorships } : {}),
      ...(this.input.restWaivers ? { restWaivers: this.input.restWaivers } : {}),
      ...(this.input.availabilityBlocks
        ? { availabilityBlocks: this.input.availabilityBlocks }
        : {}),
    });
  }

  /** Whether any shift-scope rule reads rosters beyond a shift and the one covering it. */
  get judgesOverlaps(): boolean {
    return (this.input.incompatibilityGroups?.length ?? 0) > 0;
  }

  /** The period as the input describes it. */
  baseline(): SimState {
    return new SimState(this, this.input.assignments, this.input.timeOff);
  }

  /**
   * A version of the period. Given the state it was derived from, its staffing shortfall and
   * fairness counters are re-priced only where the two differ — see `SimState.changes`.
   */
  state(
    assignments: readonly Assignment[],
    timeOff: readonly TimeOffRequest[],
    base?: SimState,
  ): SimState {
    return new SimState(this, assignments, timeOff, base);
  }

  nurse(id: Id): Nurse {
    const nurse = this.nursesById.get(id);
    if (!nurse) throw new Error(`Unknown nurse ${id}`);
    return nurse;
  }

  shiftType(id: Id): ShiftType {
    const shiftType = this.shiftTypesById.get(id);
    if (!shiftType) throw new Error(`Unknown shift type ${id}`);
    return shiftType;
  }

  inPeriod(date: IsoDate): boolean {
    return dateInRange(date, this.input.period.startDate, this.input.period.endDate);
  }
}

/**
 * One schedule-plus-requests world, with every expensive question answered lazily and cached:
 * the baseline is asked about the same nurse by every candidate that touches them, and a
 * candidate is asked about only the handful it changed.
 */
export class SimState {
  readonly engine: ConflictEngine;
  readonly assignments: readonly Assignment[];
  readonly timeOff: readonly TimeOffRequest[];
  readonly ctx: RuleContext;
  readonly view: ScheduleView;

  private readonly nurseEvaluations = new Map<Id, Violation[]>();
  private readonly shiftEvaluations = new Map<string, Violation[]>();
  private readonly nurseCosts = new Map<Id, AssignmentCost[]>();
  private fullEvaluation: EvaluationResult | undefined;
  private shortfall: number | undefined;
  private fairnessSnapshot: FairnessSnapshot | undefined;
  private scheduleCost: number | undefined;
  private counterCache: Map<Id, BurdenCounters> | undefined;
  private readonly base: SimState | undefined;
  private delta: { nurses: Set<Id>; cells: Set<string> } | undefined;

  constructor(
    engine: ConflictEngine,
    assignments: readonly Assignment[],
    timeOff: readonly TimeOffRequest[],
    base?: SimState,
  ) {
    this.engine = engine;
    this.base = base;
    this.assignments = assignments;
    this.timeOff = timeOff;
    this.ctx = engine.contextFor(timeOff);
    this.view = new ScheduleView({
      period: engine.input.period,
      assignments,
      priorAssignments: engine.input.priorAssignments,
      nurses: engine.nurses,
      shiftTypes: engine.shiftTypes,
    });
  }

  /** The whole period under every enabled rule — what detection reads. */
  evaluate(): EvaluationResult {
    if (!this.fullEvaluation) {
      this.fullEvaluation = evaluateSchedule(this.view, this.engine.input.ruleSet, this.ctx);
    }
    return this.fullEvaluation;
  }

  /** Every enabled nurse-scope rule, on a view holding only this nurse and their tail. */
  nurseViolations(nurseId: Id): Violation[] {
    const cached = this.nurseEvaluations.get(nurseId);
    if (cached) return cached;
    const nurse = this.engine.nurse(nurseId);
    const timeline = this.view.timelineFor(nurseId);
    const view = new ScheduleView({
      period: this.engine.input.period,
      assignments: timeline.filter((v) => v.inPeriod).map((v) => v.assignment),
      priorAssignments: timeline.filter((v) => !v.inPeriod).map((v) => v.assignment),
      nurses: [nurse],
      shiftTypes: this.engine.shiftTypes,
    });
    const result = evaluatePrepared(view, this.engine.nurseRules, { ...this.ctx, nurses: [nurse] });
    this.nurseEvaluations.set(nurseId, result.violations);
    return result.violations;
  }

  /**
   * Every enabled shift-scope rule, on a one-day view holding only this shift's roster — and,
   * for a shift inside another, the containing shift's roster, which covers it. When the unit
   * keeps nurses apart, every roster overlapping this shift's hours too: who shares the floor
   * with this shift is part of its verdict. The other rules read only this shift and its cover.
   */
  shiftViolations(date: IsoDate, shiftTypeId: Id): Violation[] {
    const key = `${date}::${shiftTypeId}`;
    const cached = this.shiftEvaluations.get(key);
    if (cached) return cached;
    const shiftType = this.engine.shiftType(shiftTypeId);
    const cover = coveringShift(shiftType, date, this.view.shiftTypesById);
    const around: { date: IsoDate; shiftType: ShiftType }[] = cover ? [cover] : [];
    if (this.engine.judgesOverlaps) {
      for (const other of overlappingShifts(date, shiftType, this.engine.shiftTypes)) {
        if (other.date === cover?.date && other.shiftType.id === cover.shiftType.id) continue;
        around.push(other);
      }
    }
    const roster = [
      ...this.view.onShift(date, shiftTypeId),
      ...around.flatMap((s) => this.view.rosterAt(s.date, s.shiftType.id)),
    ];
    const view = new ScheduleView({
      period: { ...this.engine.input.period, startDate: date, endDate: date },
      assignments: roster.map((v) => v.assignment),
      nurses: roster.map((v) => v.nurse),
      shiftTypes: [shiftType, ...new Set(around.map((s) => s.shiftType))],
    });
    const result = evaluatePrepared(view, this.engine.shiftRules, {
      ...this.ctx,
      shiftTypes: [shiftType],
    });
    this.shiftEvaluations.set(key, result.violations);
    return result.violations;
  }

  /**
   * This shift's violations and those of every shift running inside it: taking an RN off the
   * day 12 can leave a new grad on the mid 8 inside it uncovered, and a simulated change must
   * report that too. When the unit keeps nurses apart, every in-period shift overlapping it as
   * well: a nurse added to the day 12 can break the verdict of the mid shift beside it.
   */
  shiftViolationsAround(date: IsoDate, shiftTypeId: Id): Violation[] {
    const out = [...this.shiftViolations(date, shiftTypeId)];
    const outer = this.engine.shiftType(shiftTypeId);
    const seen = new Set<string>();
    for (const inner of this.engine.shiftTypes) {
      if (inner.withinShiftTypeId !== shiftTypeId) continue;
      // Dated the same day, or the next for a shift inside a night that began this evening.
      for (const innerDate of [date, addDays(date, 1)]) {
        if (containingDate(inner, outer, innerDate) === date) {
          seen.add(`${innerDate}::${inner.id}`);
          out.push(...this.shiftViolations(innerDate, inner.id));
        }
      }
    }
    if (this.engine.judgesOverlaps) {
      for (const other of overlappingShifts(date, outer, this.engine.shiftTypes)) {
        const key = `${other.date}::${other.shiftType.id}`;
        if (seen.has(key) || !this.engine.inPeriod(other.date)) continue;
        seen.add(key);
        out.push(...this.shiftViolations(other.date, other.shiftType.id));
      }
    }
    return out;
  }

  staffed(date: IsoDate, shiftTypeId: Id, role: RatioRole): number {
    if (role === 'licensed') {
      return (
        this.view.countOnShift(date, shiftTypeId, 'RN') +
        this.view.countOnShift(date, shiftTypeId, 'LPN')
      );
    }
    return this.view.countOnShift(date, shiftTypeId, role);
  }

  /** Nurse-slots short of the hard minimum on one cell. */
  slotShortfall(date: IsoDate, shiftTypeId: Id, role: RatioRole): number {
    const min = this.engine.demand.minFor(date, shiftTypeId, role);
    const rnMin =
      role === 'licensed' ? this.engine.demand.get(date, shiftTypeId)?.licensed?.minRn : undefined;
    return this.shortOf({ date, shiftTypeId, role, min, rnMin });
  }

  /**
   * One slot's shortfall. A licensed pool is short only beyond the RNs its share needs, as the
   * ratio rule reports it: those RNs count toward the pool too, so counting them twice would make
   * one RN and one LVN against "four, two RNs" look three short instead of two.
   */
  private shortOf(slot: {
    date: IsoDate;
    shiftTypeId: Id;
    role: RatioRole;
    min: number;
    rnMin?: number | undefined;
  }): number {
    const short = Math.max(0, slot.min - this.staffed(slot.date, slot.shiftTypeId, slot.role));
    if (slot.role !== 'licensed' || !slot.rnMin) return short;
    const rnShort = Math.max(0, slot.rnMin - this.staffed(slot.date, slot.shiftTypeId, 'RN'));
    return short - Math.min(short, rnShort);
  }

  /** Nurse-slots below a hard minimum across the whole period. */
  hardShortfall(): number {
    if (this.shortfall === undefined && this.base) {
      // The base's total, plus the change on each cell whose roster differs: a cell's
      // shortfall reads only its own roster, so every other cell is the same as in the base.
      let total = this.base.hardShortfall();
      for (const key of this.changes().cells) {
        for (const slot of this.engine.slotsByCell.get(key) ?? []) {
          const at = { ...slot, shiftTypeId: slot.shiftType.id };
          total += this.shortOf(at) - this.base.shortOf(at);
        }
      }
      this.shortfall = total;
    }
    if (this.shortfall === undefined) {
      let total = 0;
      for (const slot of this.engine.slots) {
        if (slot.min <= 0) continue;
        total += this.shortOf({ ...slot, shiftTypeId: slot.shiftType.id });
      }
      this.shortfall = total;
    }
    return this.shortfall;
  }

  /**
   * Each nurse's burden counters for this version. A nurse's counters read only her own shifts,
   * requests and preferences, so a derived state re-derives just the nurses whose shifts or
   * requests differ from its base's and keeps the base's counters for everyone else.
   */
  counters(): Map<Id, BurdenCounters> {
    if (!this.counterCache) {
      const ctx = { ...this.engine.counterCtx, timeOff: this.timeOff };
      if (this.base) {
        const counters = new Map(this.base.counters());
        for (const [id, c] of deriveCounters(this.view, ctx, this.changes().nurses)) {
          counters.set(id, c);
        }
        this.counterCache = counters;
      } else {
        this.counterCache = deriveCounters(this.view, ctx);
      }
    }
    return this.counterCache;
  }

  /**
   * Who and which cells differ from the base, by object identity: a simulated change keeps
   * every untouched assignment and request object and replaces or drops the ones it changes.
   * Computed here rather than trusted from the caller, so a fix that forgets to report a nurse
   * can never be priced against her old counters.
   */
  private changes(): { nurses: Set<Id>; cells: Set<string> } {
    if (!this.delta) {
      const base = this.base!;
      const nurses = new Set<Id>();
      const cells = new Set<string>();
      const mark = (a: Assignment) => {
        nurses.add(a.nurseId);
        cells.add(cellKey(a.date, a.shiftTypeId));
      };
      const was = new Set(base.assignments);
      const now = new Set(this.assignments);
      for (const a of this.assignments) if (!was.has(a)) mark(a);
      for (const a of base.assignments) if (!now.has(a)) mark(a);
      const wasOff = new Set(base.timeOff);
      const nowOff = new Set(this.timeOff);
      for (const r of this.timeOff) if (!wasOff.has(r)) nurses.add(r.nurseId);
      for (const r of base.timeOff) if (!nowOff.has(r)) nurses.add(r.nurseId);
      this.delta = { nurses, cells };
    }
    return this.delta;
  }

  fairness(): FairnessSnapshot {
    if (!this.fairnessSnapshot) {
      const { engine } = this;
      this.fairnessSnapshot = engine.fairnessEvaluator.score(this.counters());
    }
    return this.fairnessSnapshot;
  }

  /** The period's priced total. Zero without pay data. */
  costTotal(): number {
    if (this.scheduleCost === undefined) {
      const { costCtx } = this.engine;
      this.scheduleCost = costCtx ? costSchedule(this.view, costCtx).totals.total : 0;
    }
    return this.scheduleCost;
  }

  /** One nurse's priced in-period assignments. Empty without pay data. */
  nurseCost(nurseId: Id): AssignmentCost[] {
    const cached = this.nurseCosts.get(nurseId);
    if (cached) return cached;
    const { costCtx } = this.engine;
    const costs = costCtx ? costNurse(this.view, costCtx, nurseId) : [];
    this.nurseCosts.set(nurseId, costs);
    return costs;
  }

  /** In-period assignments of one nurse inside an inclusive date range. */
  assignmentsWithin(nurseId: Id, start: IsoDate, end: IsoDate): Assignment[] {
    return this.view
      .assignmentsFor(nurseId)
      .filter((v) => dateInRange(v.assignment.date, start, end))
      .map((v) => v.assignment);
  }

  /** Pending requests covering a date, for one nurse. */
  pendingOn(nurseId: Id, date: IsoDate): TimeOffRequest[] {
    return this.timeOff.filter(
      (r) =>
        r.nurseId === nurseId &&
        r.status === 'pending' &&
        dateInRange(date, r.startDate, r.endDate),
    );
  }
}

function cellKey(date: IsoDate, shiftTypeId: Id): string {
  return `${date}|${shiftTypeId}`;
}
