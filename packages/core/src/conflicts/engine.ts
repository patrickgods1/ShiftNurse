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
  NurseRole,
  ShiftType,
  TimeOffRequest,
} from '../domain/entities.js';
import { dateInRange, datesInRange, type IsoDate } from '../domain/time.js';
import { deriveCounters } from '../fairness/ledger.js';
import { scoreFairness } from '../fairness/score.js';
import type { CounterContext } from '../fairness/types.js';
import { type MaxHoursParams, maxHoursRule } from '../rules/hours-rules.js';
import { buildRuleContext, evaluateSchedule, getRule, resolveConfigs } from '../rules/registry.js';
import type { EvaluationResult, RuleContext, RuleScope, Violation } from '../rules/types.js';
import { ScheduleView } from '../schedule/view.js';
import type { ConflictInput } from './types.js';

/** One (date, shift type, role) cell with a hard minimum or soft target, in calendar order. */
export interface Slot {
  date: IsoDate;
  shiftType: ShiftType;
  role: NurseRole;
  min: number;
  target: number;
}

export interface FairnessSnapshot {
  /** Unit mean of the per-nurse composite over comparable nurses, 0–100. */
  mean: number;
  byNurse: ReadonlyMap<Id, number>;
}

/** Ids of every enabled rule of one scope — hard and soft, since simulations diff both. */
function ruleIdsByScope(input: ConflictInput, scope: RuleScope): string[] {
  const out: string[] = [];
  for (const config of resolveConfigs(input.ruleSet)) {
    if (!config.enabled) continue;
    const rule = getRule(config.ruleId);
    if (rule && rule.scope === scope) out.push(rule.id);
  }
  return out;
}

export class ConflictEngine {
  readonly input: ConflictInput;
  /** Sorted by id so every iteration order is independent of row order. */
  readonly nurses: readonly Nurse[];
  readonly activeNurses: readonly Nurse[];
  readonly nursesById: ReadonlyMap<Id, Nurse>;
  readonly shiftTypes: readonly ShiftType[];
  readonly shiftTypesById: ReadonlyMap<Id, ShiftType>;
  readonly dates: readonly IsoDate[];
  readonly demand: DemandTable;
  readonly slots: readonly Slot[];
  readonly nurseRuleIds: readonly string[];
  readonly shiftRuleIds: readonly string[];
  readonly maxHoursParams: MaxHoursParams;
  readonly costCtx: CostContext | undefined;
  readonly counterCtx: Omit<CounterContext, 'timeOff'>;
  private readonly baseCtx: RuleContext;

  constructor(input: ConflictInput) {
    this.input = input;
    this.nurses = [...input.nurses].sort((a, b) => a.id.localeCompare(b.id));
    this.activeNurses = this.nurses.filter((n) => n.active);
    this.nursesById = new Map(this.nurses.map((n) => [n.id, n]));
    this.shiftTypes = [...input.shiftTypes].sort((a, b) => a.sortOrder - b.sortOrder);
    this.shiftTypesById = new Map(this.shiftTypes.map((s) => [s.id, s]));
    this.dates = datesInRange(input.period.startDate, input.period.endDate);
    this.demand = new DemandTable(input.demand);
    this.baseCtx = this.contextFor(input.timeOff);
    this.nurseRuleIds = ruleIdsByScope(input, 'nurse');
    this.shiftRuleIds = ruleIdsByScope(input, 'shift');

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
      }
    }
    this.slots = slots;

    this.costCtx = input.cost
      ? {
          unit: input.unit,
          payRates: input.cost.payRates,
          differentials: input.cost.differentials.filter((d) => d.active),
          overtimeRules: input.cost.overtimeRules.filter((r) => r.active),
          holidayDates: this.baseCtx.holidayDates,
          weekendDefinition: input.ruleSet.weekendDefinition,
          workWeekStartsOn: this.maxHoursParams.workWeekStartsOn,
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
    });
  }

  /** The period as the input describes it. */
  baseline(): SimState {
    return new SimState(this, this.input.assignments, this.input.timeOff);
  }

  state(assignments: readonly Assignment[], timeOff: readonly TimeOffRequest[]): SimState {
    return new SimState(this, assignments, timeOff);
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

  constructor(
    engine: ConflictEngine,
    assignments: readonly Assignment[],
    timeOff: readonly TimeOffRequest[],
  ) {
    this.engine = engine;
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
    const result = evaluateSchedule(
      view,
      this.engine.input.ruleSet,
      { ...this.ctx, nurses: [nurse] },
      { only: this.engine.nurseRuleIds },
    );
    this.nurseEvaluations.set(nurseId, result.violations);
    return result.violations;
  }

  /** Every enabled shift-scope rule, on a one-day view holding only this shift's roster. */
  shiftViolations(date: IsoDate, shiftTypeId: Id): Violation[] {
    const key = `${date}::${shiftTypeId}`;
    const cached = this.shiftEvaluations.get(key);
    if (cached) return cached;
    const shiftType = this.engine.shiftType(shiftTypeId);
    const roster = this.view.onShift(date, shiftTypeId);
    const view = new ScheduleView({
      period: { ...this.engine.input.period, startDate: date, endDate: date },
      assignments: roster.map((v) => v.assignment),
      nurses: roster.map((v) => v.nurse),
      shiftTypes: [shiftType],
    });
    const result = evaluateSchedule(
      view,
      this.engine.input.ruleSet,
      { ...this.ctx, shiftTypes: [shiftType] },
      { only: this.engine.shiftRuleIds },
    );
    this.shiftEvaluations.set(key, result.violations);
    return result.violations;
  }

  staffed(date: IsoDate, shiftTypeId: Id, role: NurseRole): number {
    return this.view.countOnShift(date, shiftTypeId, role);
  }

  /** Nurse-slots short of the hard minimum on one cell. */
  slotShortfall(date: IsoDate, shiftTypeId: Id, role: NurseRole): number {
    const min = this.engine.demand.minFor(date, shiftTypeId, role);
    return Math.max(0, min - this.staffed(date, shiftTypeId, role));
  }

  /** Nurse-slots below a hard minimum across the whole period. */
  hardShortfall(): number {
    if (this.shortfall === undefined) {
      let total = 0;
      for (const slot of this.engine.slots) {
        if (slot.min <= 0) continue;
        total += Math.max(0, slot.min - this.staffed(slot.date, slot.shiftType.id, slot.role));
      }
      this.shortfall = total;
    }
    return this.shortfall;
  }

  fairness(): FairnessSnapshot {
    if (!this.fairnessSnapshot) {
      const { engine } = this;
      const report = scoreFairness({
        nurses: engine.activeNurses,
        current: deriveCounters(this.view, { ...engine.counterCtx, timeOff: this.timeOff }),
        history: engine.input.ledgerHistory,
        preferences: engine.input.preferences,
        weights: engine.input.ruleSet.fairnessWeights,
      });
      this.fairnessSnapshot = {
        mean: report.distribution.score.mean,
        byNurse: new Map(report.scores.map((s) => [s.nurseId, s.score])),
      };
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
