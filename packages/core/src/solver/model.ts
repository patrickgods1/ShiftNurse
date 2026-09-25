/**
 * The solver's working state: the schedule under construction, indexed for the two questions
 * local search asks thousands of times a second — "may this nurse take this shift?" and
 * "how much better or worse is the schedule with it?"
 *
 * ## Why the rule engine is called on partial views
 *
 * Re-evaluating the whole period after every candidate move would cost ~14ms per move on a
 * real unit and make annealing unusable. But every shipped rule declares a scope (`RuleScope`):
 * nurse-scope rules read one nurse's timeline, shift-scope rules read one shift's roster. So
 * the gate builds a `ScheduleView` holding only the nurse in question (plus their lookback
 * tail) and evaluates only the hard nurse-scope rules; the coverage term builds a one-day view
 * holding only that shift's roster and evaluates only the hard shift-scope rules. Both are the
 * real rules with the real parameters — no second implementation of "minimum rest" lives here,
 * so a rule added to the registry with a truthful scope is honoured by the solver for free.
 *
 * ## Why the objective is maintained incrementally
 *
 * Every term except fairness is a sum over shifts or nurses of something that depends only on
 * that shift's roster or that nurse's counters, so each is cached per shift/nurse and only the
 * touched entries are recomputed. Fairness compares every nurse to the team, so it is
 * recomputed in full — but from a handful of per-nurse counters, which is a few hundred
 * operations, not a pass over the schedule.
 *
 * ## Fairness in the objective vs. the fairness score
 *
 * The score (`fairness/score.ts`) reports a *relative* deviation — "+50% over share" — because
 * that is the sentence a manager reads out. The objective penalises the *absolute* over-share
 * in the counter's own units (nights, weekends…), weighted by the same fairness weights,
 * because a nurse carrying seven nights against a share of three-and-a-half must cost more
 * than one carrying two against one — a relative penalty would price them the same. Both
 * read the same `carried − fairShare`, with the same fair-share formula as `computeBurden`.
 */

import { DemandTable, NURSE_ROLES, type ShiftDemand } from '../acuity/demand.js';
import { costNurse } from '../cost/cost.js';
import type { CostContext } from '../cost/types.js';
import type { Assignment, Id, Nurse, NurseRole, ShiftType } from '../domain/entities.js';
import {
  dateInRange,
  datesInRange,
  dayNumber,
  type IsoDate,
  isWeekendWindow,
  shiftWindow,
  weekdayOf,
  weekendKey,
} from '../domain/time.js';
import { computeBurden } from '../fairness/burden.js';
import { isUndesirable } from '../fairness/ledger.js';
import { seniorityMultipliers } from '../fairness/seniority.js';
import {
  BURDEN_COMPONENTS,
  BURDEN_COUNTER,
  type BurdenComponent,
  type BurdenCounters,
  EMPTY_COUNTERS,
} from '../fairness/types.js';
import { approvedLeaveOn } from '../rules/availability-rules.js';
import {
  type ContractedHoursParams,
  contractedHoursRule,
  type MaxHoursParams,
  maxHoursRule,
  payPeriodsIn,
} from '../rules/hours-rules.js';
import {
  buildRuleContext,
  evaluateSchedule,
  hardRuleIdsByScope,
  resolveConfigs,
} from '../rules/registry.js';
import type { RuleContext, RuleSet } from '../rules/types.js';
import { type AssignmentView, ScheduleView } from '../schedule/view.js';
import {
  DEFAULT_OBJECTIVE_WEIGHTS,
  type ObjectiveBreakdown,
  type ObjectiveWeights,
  type SolveInput,
} from './types.js';

/** One (date, shift type) cell of the period. */
export interface Shift {
  idx: number;
  date: IsoDate;
  dateIdx: number;
  shiftType: ShiftType;
  demand: ShiftDemand | undefined;
  /** Active, with demand for at least one role: somewhere the solver may place a nurse. */
  solvable: boolean;
}

/** What `add` needs to hand back so `undoAdd` can restore caches without re-evaluating. */
export interface AddToken {
  coverageBefore: number;
  hoursBefore: number;
}

export type RemoveToken = AddToken;

/** A deep enough copy of the unlocked assignments to restore the best schedule found. */
export type Snapshot = Assignment[];

/** Nurse-scope violation codes the gate ignores: floors reached by construction, not caused by an addition. */
const FLOOR_CODES = new Set(['under_contracted_hours']);

export class SolverModel {
  readonly input: SolveInput;
  readonly ruleSet: RuleSet;
  readonly ctx: RuleContext;
  readonly weights: ObjectiveWeights;
  readonly costCtx: CostContext | undefined;

  /** Every nurse on the input, sorted by id so the search is independent of row order. */
  readonly nurses: readonly Nurse[];
  /** Indexes into `nurses` of the nurses who may receive new shifts. */
  readonly candidates: readonly number[];
  readonly nurseIdx: ReadonlyMap<Id, number>;
  readonly dates: readonly IsoDate[];
  readonly dateIdx: ReadonlyMap<IsoDate, number>;
  readonly shiftTypes: readonly ShiftType[];
  readonly shifts: readonly Shift[];
  /** Shifts the solver may place nurses on, in date then sort order. */
  readonly solvableShifts: readonly Shift[];

  // --- Schedule state --------------------------------------------------------
  private readonly byNurse: Assignment[][];
  private readonly byShift: Assignment[][];
  /** Per nurse: the published lookback tail before the period. */
  readonly prior: readonly Assignment[][];
  /** Every assignment the solver may move or remove, in no particular order. */
  readonly unlocked: Assignment[] = [];
  private idCounter = 0;

  // --- Cached objective terms ------------------------------------------------
  private readonly coverage: number[];
  private coverageSum = 0;
  private readonly hoursPenalty: number[];
  private hoursSum = 0;
  private prefSum = 0;
  private costSum = 0;

  // --- Per-nurse counters feeding fairness and hours ---------------------------
  private readonly workedHours: number[];
  private readonly bucketHours: number[][];
  private readonly nights: number[];
  private readonly holidays: number[];
  private readonly onCall: number[];
  private readonly undesirable: number[];
  private readonly weekendKeys: Map<string, number>[];
  /** nurse × date → assignments starting that day. O(1) "is this nurse free that day". */
  private readonly onDate: number[][];
  /** nurse × date → on approved leave. Leave never changes during a solve. */
  private readonly onLeave: boolean[][];
  /** nurse × work week → hours that count toward the weekly cap, lookback tail included. */
  private readonly weekHours: number[][];

  // --- Precomputed inputs ----------------------------------------------------
  // Public and read-only so the CP-SAT encoder (cpsat/) reads the same tables instead of
  // re-deriving pay-period buckets, fair shares or preference weights a second way.
  readonly nurseHardIds: readonly string[];
  readonly shiftHardIds: readonly string[];
  private readonly baselineViolations: number[];
  readonly fteParams: ContractedHoursParams;
  readonly bucketOfDate: number[];
  readonly hoursTarget: number[][];
  readonly hoursCapped: boolean[];
  readonly contractedProRata: number[];
  readonly maxHoursParams: MaxHoursParams;
  /** date index → work-week index, counted from the week containing the period's first day. */
  readonly weekOfDate: number[];
  /** Same for any date, prior or in-period; negative before the first week. */
  private readonly weekOf: (date: IsoDate) => number;
  private readonly weekCount: number;
  readonly histCarried: Record<BurdenComponent, number>[];
  readonly shareWeight: number[];
  readonly teamShare: number;
  readonly seniority: number[];
  private readonly prefCache = new Map<number, number>();
  private readonly undesirableCache = new Map<number, boolean>();
  private readonly costCache = new Map<number, number>();

  constructor(input: SolveInput, weights: Partial<ObjectiveWeights> = {}) {
    this.input = input;
    this.ruleSet = input.ruleSet;
    this.weights = { ...DEFAULT_OBJECTIVE_WEIGHTS, ...weights };

    this.nurses = [...input.nurses].sort((a, b) => a.id.localeCompare(b.id));
    this.nurseIdx = new Map(this.nurses.map((n, i) => [n.id, i]));
    this.candidates = this.nurses.flatMap((n, i) => (n.active ? [i] : []));
    this.dates = datesInRange(input.period.startDate, input.period.endDate);
    this.dateIdx = new Map(this.dates.map((d, i) => [d, i]));
    this.shiftTypes = [...input.shiftTypes].sort((a, b) => a.sortOrder - b.sortOrder);

    const demand = new DemandTable(input.demand);
    this.ctx = buildRuleContext({
      unit: input.unit,
      demand,
      nurses: this.nurses,
      shiftTypes: this.shiftTypes,
      timeOff: input.timeOff,
      credentials: input.credentials,
      nurseCredentials: input.nurseCredentials,
      shiftCredentialRequirements: input.shiftCredentialRequirements,
      holidays: input.holidays,
      weekendDefinition: input.ruleSet.weekendDefinition,
    });

    const shifts: Shift[] = [];
    for (const [dateIdx, date] of this.dates.entries()) {
      for (const shiftType of this.shiftTypes) {
        const row = demand.get(date, shiftType.id);
        const wanted =
          row !== undefined &&
          NURSE_ROLES.some(
            (role) => Math.max(row.byRole[role].minCount, row.byRole[role].targetCount) > 0,
          );
        shifts.push({
          idx: shifts.length,
          date,
          dateIdx,
          shiftType,
          demand: row,
          solvable: shiftType.active && wanted,
        });
      }
    }
    this.shifts = shifts;
    this.solvableShifts = shifts.filter((s) => s.solvable);

    this.nurseHardIds = hardRuleIdsByScope(input.ruleSet, 'nurse');
    this.shiftHardIds = hardRuleIdsByScope(input.ruleSet, 'shift');

    const configs = resolveConfigs(input.ruleSet);
    this.fteParams = (configs.find((c) => c.ruleId === contractedHoursRule.id)?.params ??
      contractedHoursRule.defaultParams) as ContractedHoursParams;
    const maxHours = (configs.find((c) => c.ruleId === maxHoursRule.id)?.params ??
      maxHoursRule.defaultParams) as MaxHoursParams;
    this.maxHoursParams = maxHours;
    const firstDay = dayNumber(input.period.startDate);
    const weekStart =
      firstDay - ((weekdayOf(input.period.startDate) - maxHours.workWeekStartsOn + 7) % 7);
    this.weekOf = (date) => Math.floor((dayNumber(date) - weekStart) / 7);
    this.weekOfDate = this.dates.map((date) => this.weekOf(date));
    this.weekCount = (this.weekOfDate[this.weekOfDate.length - 1] ?? 0) + 1;

    this.costCtx = input.cost
      ? {
          unit: input.unit,
          payRates: input.cost.payRates,
          differentials: input.cost.differentials.filter((d) => d.active),
          overtimeRules: input.cost.overtimeRules.filter((r) => r.active),
          holidayDates: this.ctx.holidayDates,
          weekendDefinition: input.ruleSet.weekendDefinition,
          workWeekStartsOn: maxHours.workWeekStartsOn,
        }
      : undefined;

    // --- Hours buckets: the complete pay periods the FTE rule judges, plus any remainder. ---
    const periods = payPeriodsIn(
      { start: input.period.startDate, end: input.period.endDate },
      input.unit,
      true,
    );
    this.bucketOfDate = this.dates.map((date) => {
      const i = periods.findIndex((p) => dateInRange(date, p.start, p.end));
      return i === -1 ? periods.length : i;
    });
    const bucketDays = new Array<number>(periods.length + 1).fill(0);
    for (const b of this.bucketOfDate) bucketDays[b] = (bucketDays[b] ?? 0) + 1;
    const bucketCount = bucketDays[periods.length] === 0 ? periods.length : periods.length + 1;

    const n = this.nurses.length;
    this.hoursTarget = this.nurses.map((nurse) =>
      Array.from({ length: bucketCount }, (_, b) =>
        nurse.contractedHoursPerPeriod > 0
          ? (nurse.contractedHoursPerPeriod * (bucketDays[b] ?? 0)) / input.unit.payPeriodDays
          : 0,
      ),
    );
    this.hoursCapped = this.nurses.map(
      (nurse) =>
        nurse.contractedHoursPerPeriod > 0 &&
        !this.fteParams.exemptEmploymentTypes.includes(nurse.employmentType),
    );
    this.contractedProRata = this.nurses.map((nurse) =>
      nurse.contractedHoursPerPeriod > 0
        ? (nurse.contractedHoursPerPeriod * this.dates.length) / input.unit.payPeriodDays
        : 0,
    );

    // --- Historical burden, weighted exactly as computeBurden weights it under a current row. ---
    const activeNurses = this.candidates.map((i) => this.nurses[i]!);
    const zero = new Map<Id, BurdenCounters>(activeNurses.map((x) => [x.id, EMPTY_COUNTERS]));
    const burden = computeBurden(
      activeNurses,
      input.ledgerHistory,
      { weights: input.ruleSet.fairnessWeights },
      zero,
    );
    this.histCarried = this.nurses.map((nurse) => {
      const row = burden.byNurse.get(nurse.id);
      const out = {} as Record<BurdenComponent, number>;
      for (const c of BURDEN_COMPONENTS) out[c] = row ? row.carried[BURDEN_COUNTER[c]] : 0;
      return out;
    });
    this.shareWeight = this.nurses.map((nurse) => burden.byNurse.get(nurse.id)?.shareWeight ?? 0);
    this.teamShare = this.shareWeight.reduce((sum, w) => sum + w, 0);

    const multipliers = seniorityMultipliers(activeNurses);
    this.seniority = this.nurses.map((nurse) => multipliers.get(nurse.id) ?? 1);

    // --- State ---
    this.byNurse = Array.from({ length: n }, () => []);
    this.byShift = this.shifts.map(() => []);
    const prior: Assignment[][] = Array.from({ length: n }, () => []);
    for (const a of input.priorAssignments) {
      const i = this.nurseIdx.get(a.nurseId);
      if (i === undefined)
        throw new Error(`Prior assignment ${a.id} references unknown nurse ${a.nurseId}`);
      prior[i]!.push(a);
    }
    this.prior = prior;
    this.workedHours = new Array<number>(n).fill(0);
    this.bucketHours = Array.from({ length: n }, () => new Array<number>(bucketCount).fill(0));
    this.nights = new Array<number>(n).fill(0);
    this.holidays = new Array<number>(n).fill(0);
    this.onCall = new Array<number>(n).fill(0);
    this.undesirable = new Array<number>(n).fill(0);
    this.weekendKeys = Array.from({ length: n }, () => new Map());
    this.onDate = Array.from({ length: n }, () => new Array<number>(this.dates.length).fill(0));
    this.onLeave = this.nurses.map((nurse) =>
      this.dates.map((date) => approvedLeaveOn(this.ctx, nurse.id, date) !== undefined),
    );
    this.weekHours = Array.from({ length: n }, () => new Array<number>(this.weekCount).fill(0));
    for (const [i, list] of prior.entries()) {
      for (const a of list) {
        const week = this.weekOf(a.date);
        if (week < 0 || week >= this.weekCount) continue;
        const st = this.shiftTypes.find((s) => s.id === a.shiftTypeId);
        if (st && (!st.isOnCall || maxHours.onCallCountsTowardHours)) {
          this.weekHours[i]![week]! += st.durationHours;
        }
      }
    }
    this.hoursPenalty = new Array<number>(n).fill(0);
    this.coverage = this.shifts.map(() => 0);

    // Locked assignments are the manager's pins: placed first, never moved, and any hard
    // violation they already carry is the baseline the gate measures additions against.
    for (const a of input.assignments) {
      if (!a.isLocked) continue;
      this.add(a);
    }
    this.baselineViolations = this.nurses.map((_, i) => this.countHardViolations(i, null));

    // Every cached term from scratch: the adds above refreshed only the shifts and nurses
    // they touched, and an empty shift already owes its whole floor.
    this.hoursSum = 0;
    for (let i = 0; i < n; i++) {
      this.hoursPenalty[i] = this.hoursPenaltyFor(i);
      this.hoursSum += this.hoursPenalty[i]!;
    }
    this.coverageSum = 0;
    for (const shift of this.shifts) {
      this.coverage[shift.idx] = this.coveragePenalty(shift);
      this.coverageSum += this.coverage[shift.idx]!;
    }
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  shiftAt(dateIdx: number, shiftType: ShiftType): Shift {
    const typeIdx = this.shiftTypes.indexOf(shiftType);
    return this.shifts[dateIdx * this.shiftTypes.length + typeIdx]!;
  }

  shiftOf(a: Assignment): Shift {
    const dateIdx = this.dateIdx.get(a.date);
    const type = this.shiftTypes.find((s) => s.id === a.shiftTypeId);
    if (dateIdx === undefined || !type) {
      throw new Error(`Assignment ${a.id} on ${a.date}/${a.shiftTypeId} is outside the period`);
    }
    return this.shiftAt(dateIdx, type);
  }

  nurseOf(a: Assignment): number {
    const i = this.nurseIdx.get(a.nurseId);
    if (i === undefined)
      throw new Error(`Assignment ${a.id} references unknown nurse ${a.nurseId}`);
    return i;
  }

  roster(shift: Shift): readonly Assignment[] {
    return this.byShift[shift.idx]!;
  }

  timeline(nurseIdx: number): readonly Assignment[] {
    return this.byNurse[nurseIdx]!;
  }

  staffed(shift: Shift, role: NurseRole): number {
    let count = 0;
    for (const a of this.byShift[shift.idx]!) {
      if (this.nurses[this.nurseOf(a)]!.role === role) count++;
    }
    return count;
  }

  isOnDate(nurseIdx: number, dateIdx: number): boolean {
    return this.onDate[nurseIdx]![dateIdx]! > 0;
  }

  /** Solvable shifts with at least one role below its hard minimum, in calendar order. */
  shortShifts(): Shift[] {
    const out: Shift[] = [];
    for (const shift of this.solvableShifts) {
      if (!shift.demand) continue;
      for (const role of NURSE_ROLES) {
        if (this.staffed(shift, role) < shift.demand.byRole[role].minCount) {
          out.push(shift);
          break;
        }
      }
    }
    return out;
  }

  /** Roles below their hard minimum on one shift. */
  shortRoles(shift: Shift): NurseRole[] {
    if (!shift.demand) return [];
    const demand = shift.demand;
    return NURSE_ROLES.filter((role) => this.staffed(shift, role) < demand.byRole[role].minCount);
  }

  /** Candidate nurses still owed contracted hours. */
  underHoursNurses(): number[] {
    return this.candidates.filter((i) => this.hoursShort(i) > 0);
  }

  /** Hours a nurse is short of contract across every bucket. Zero for exempt nurses. */
  hoursShort(nurseIdx: number): number {
    if (!this.hoursCapped[nurseIdx]) return 0;
    let short = 0;
    const target = this.hoursTarget[nurseIdx]!;
    const hours = this.bucketHours[nurseIdx]!;
    for (let b = 0; b < target.length; b++) short += Math.max(0, target[b]! - hours[b]!);
    return short;
  }

  /**
   * The cheap pre-filter before the rule gate: right role for the slot, active, free that day,
   * not on approved leave, and not already at the top of their hours tolerance. Everything it
   * rejects the gate would reject too; it exists so the gate runs on a shortlist.
   */
  eligible(nurseIdx: number, shift: Shift, role: NurseRole | null): boolean {
    const nurse = this.nurses[nurseIdx]!;
    if (!nurse.active) return false;
    if (role !== null && nurse.role !== role) return false;
    if (this.isOnDate(nurseIdx, shift.dateIdx)) return false;
    if (this.onLeave[nurseIdx]![shift.dateIdx]) return false;
    if (this.hoursCapped[nurseIdx]) {
      const b = this.bucketOfDate[shift.dateIdx]!;
      const cap = this.hoursTarget[nurseIdx]![b]! + this.fteParams.overToleranceHours;
      if (this.bucketHours[nurseIdx]![b]! + shift.shiftType.durationHours > cap) return false;
    }
    // The weekly cap binds on every nurse, and the overtime threshold does too unless the
    // solver could authorise overtime — which it never does.
    if (!shift.shiftType.isOnCall || this.maxHoursParams.onCallCountsTowardHours) {
      const week = this.weekOfDate[shift.dateIdx]!;
      const after = this.weekHours[nurseIdx]![week]! + shift.shiftType.durationHours;
      if (after > this.maxHoursParams.maxHoursPerWeek) return false;
      if (
        this.maxHoursParams.requireOvertimeAuthorisation &&
        after > this.maxHoursParams.overtimeThresholdHours
      ) {
        return false;
      }
    }
    return true;
  }

  /** A fresh, unlocked solver assignment for this nurse on this shift. */
  make(nurseIdx: number, shift: Shift): Assignment {
    this.idCounter++;
    return {
      id: `sol-${this.idCounter}`,
      periodId: this.input.period.id,
      nurseId: this.nurses[nurseIdx]!.id,
      shiftTypeId: shift.shiftType.id,
      date: shift.date,
      source: 'solver',
      isLocked: false,
      isCharge: false,
      isOvertime: false,
    };
  }

  // ---------------------------------------------------------------------------
  // The gate
  // ---------------------------------------------------------------------------

  /**
   * Would this nurse's timeline still pass every hard nurse-scope rule with `candidate` on it?
   * Measured against the violations their locked shifts already carry, so a pinned problem
   * does not freeze the nurse out of every other shift.
   */
  canAdd(nurseIdx: number, candidate: Assignment): boolean {
    return this.countHardViolations(nurseIdx, candidate) <= this.baselineViolations[nurseIdx]!;
  }

  /**
   * Does this nurse's timeline, as it stands, pass every hard nurse-scope rule (against the same
   * locked-shift baseline as `canAdd`)? Needed after taking a shift *away*: most rules can only
   * be broken by adding, but not all — the consecutive-nights limit counts only stretches made
   * entirely of nights, so removing the day shift from "day + four nights" creates a violation.
   */
  isLegal(nurseIdx: number): boolean {
    return this.countHardViolations(nurseIdx, null) <= this.baselineViolations[nurseIdx]!;
  }

  private countHardViolations(nurseIdx: number, candidate: Assignment | null): number {
    const nurse = this.nurses[nurseIdx]!;
    const own = this.byNurse[nurseIdx]!;
    const view = new ScheduleView({
      period: this.input.period,
      assignments: candidate ? [...own, candidate] : own,
      priorAssignments: this.prior[nurseIdx]!,
      nurses: [nurse],
      shiftTypes: this.shiftTypes,
    });
    const result = evaluateSchedule(
      view,
      this.ruleSet,
      { ...this.ctx, nurses: [nurse] },
      { only: this.nurseHardIds },
    );
    let count = 0;
    for (const v of result.hardViolations) if (!FLOOR_CODES.has(v.code)) count++;
    return count;
  }

  // ---------------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------------

  add(a: Assignment): AddToken {
    const n = this.nurseOf(a);
    const shift = this.shiftOf(a);
    this.byNurse[n]!.push(a);
    this.byShift[shift.idx]!.push(a);
    if (!a.isLocked) this.unlocked.push(a);
    this.count(n, shift, a, +1);
    this.ensureCharge(shift);
    const token = { coverageBefore: this.coverage[shift.idx]!, hoursBefore: this.hoursPenalty[n]! };
    this.refresh(n, shift);
    return token;
  }

  remove(a: Assignment): RemoveToken {
    const n = this.nurseOf(a);
    const shift = this.shiftOf(a);
    if (a.isLocked) throw new Error(`Assignment ${a.id} is locked and cannot be removed`);
    spliceOut(this.byNurse[n]!, a);
    spliceOut(this.byShift[shift.idx]!, a);
    spliceOut(this.unlocked, a);
    // The charge flag belongs to the shift, not the nurse; it is re-earned on the next add.
    a.isCharge = false;
    this.count(n, shift, a, -1);
    this.ensureCharge(shift);
    const token = { coverageBefore: this.coverage[shift.idx]!, hoursBefore: this.hoursPenalty[n]! };
    this.refresh(n, shift);
    return token;
  }

  /** Reverse an `add` without re-evaluating the shift: the caches go back to what the token holds. */
  undoAdd(a: Assignment, token: AddToken): void {
    const n = this.nurseOf(a);
    const shift = this.shiftOf(a);
    spliceOut(this.byNurse[n]!, a);
    spliceOut(this.byShift[shift.idx]!, a);
    spliceOut(this.unlocked, a);
    a.isCharge = false;
    this.count(n, shift, a, -1);
    this.ensureCharge(shift);
    this.restoreCaches(n, shift, token);
  }

  undoRemove(a: Assignment, token: RemoveToken): void {
    const n = this.nurseOf(a);
    const shift = this.shiftOf(a);
    this.byNurse[n]!.push(a);
    this.byShift[shift.idx]!.push(a);
    this.unlocked.push(a);
    this.count(n, shift, a, +1);
    this.ensureCharge(shift);
    this.restoreCaches(n, shift, token);
  }

  private restoreCaches(n: number, shift: Shift, token: AddToken): void {
    this.coverageSum += token.coverageBefore - this.coverage[shift.idx]!;
    this.coverage[shift.idx] = token.coverageBefore;
    this.hoursSum += token.hoursBefore - this.hoursPenalty[n]!;
    this.hoursPenalty[n] = token.hoursBefore;
  }

  private refresh(n: number, shift: Shift): void {
    const coverage = this.coveragePenalty(shift);
    this.coverageSum += coverage - this.coverage[shift.idx]!;
    this.coverage[shift.idx] = coverage;
    const hours = this.hoursPenaltyFor(n);
    this.hoursSum += hours - this.hoursPenalty[n]!;
    this.hoursPenalty[n] = hours;
  }

  /** Update every per-nurse counter and the preference/cost sums for one assignment. */
  private count(n: number, shift: Shift, a: Assignment, sign: 1 | -1): void {
    const st = shift.shiftType;
    this.onDate[n]![shift.dateIdx]! += sign;
    if (!st.isOnCall || this.maxHoursParams.onCallCountsTowardHours) {
      this.weekHours[n]![this.weekOfDate[shift.dateIdx]!]! += sign * st.durationHours;
    }
    if (st.isOnCall) {
      this.onCall[n]! += sign;
      if (this.fteParams.onCallCountsTowardHours) {
        this.bucketHours[n]![this.bucketOfDate[shift.dateIdx]!]! += sign * st.durationHours;
      }
    } else {
      this.workedHours[n]! += sign * st.durationHours;
      this.bucketHours[n]![this.bucketOfDate[shift.dateIdx]!]! += sign * st.durationHours;
      if (st.isNight) this.nights[n]! += sign;
      if (this.ctx.holidayDates.has(shift.date)) this.holidays[n]! += sign;
      if (this.isUndesirable(n, shift)) this.undesirable[n]! += sign;
      const key = weekendKey(shiftWindow(shift.date, st), this.ctx.weekendDefinition);
      if (key !== null) {
        const keys = this.weekendKeys[n]!;
        const next = (keys.get(key) ?? 0) + sign;
        if (next <= 0) keys.delete(key);
        else keys.set(key, next);
      }
    }
    this.prefSum += sign * this.preferencePenalty(n, shift);
    this.costSum += sign * this.shiftCost(n, shift, a);
  }

  /**
   * Exactly one charge nurse per worked shift when one is available. The first eligible,
   * unlocked nurse on the roster gets it — deterministic, and re-run after every change so a
   * removed charge nurse hands the role to whoever is left.
   */
  private ensureCharge(shift: Shift): void {
    if (shift.shiftType.isOnCall) return;
    const roster = this.byShift[shift.idx]!;
    if (roster.some((a) => a.isCharge)) return;
    const pick = roster.find((a) => !a.isLocked && this.nurses[this.nurseOf(a)]!.isChargeEligible);
    if (pick) pick.isCharge = true;
  }

  // ---------------------------------------------------------------------------
  // Objective terms
  // ---------------------------------------------------------------------------

  objective(): number {
    return (
      this.coverageSum +
      this.hoursSum +
      this.fairness() +
      this.prefSum * this.weights.preference +
      this.costSum * this.weights.cost
    );
  }

  breakdown(): ObjectiveBreakdown {
    const coverage = this.coverageSum;
    const hours = this.hoursSum;
    const fairness = this.fairness();
    const preferences = this.prefSum * this.weights.preference;
    const cost = this.costSum * this.weights.cost;
    return {
      total: coverage + hours + fairness + preferences + cost,
      coverage,
      hours,
      fairness,
      preferences,
      cost,
    };
  }

  /** Nurse-slots short of a hard minimum across the whole schedule, for progress reporting. */
  /** One shift's cached coverage penalty in points, as it stands. */
  coveragePenaltyOf(shift: Shift): number {
    return this.coverage[shift.idx]!;
  }

  /** One nurse's cached under-hours penalty in points, as it stands. */
  hoursPenaltyOf(n: number): number {
    return this.hoursPenalty[n]!;
  }

  hardShortfall(): number {
    let total = 0;
    for (const shift of this.shifts) {
      if (!shift.demand) continue;
      for (const role of NURSE_ROLES) {
        const min = shift.demand.byRole[role].minCount;
        if (min > 0) total += Math.max(0, min - this.staffed(shift, role));
      }
    }
    return total;
  }

  /**
   * One shift's contribution: hard shift-scope violations from the real rules (a shortfall of
   * `k` nurses costs `k` units), plus the soft distance from the target headcount.
   */
  private coveragePenalty(shift: Shift): number {
    const roster = this.byShift[shift.idx]!;
    if (!shift.solvable && roster.length === 0) return 0;
    let hard = 0;
    if (shift.demand) {
      const view = new ScheduleView({
        period: { ...this.input.period, startDate: shift.date, endDate: shift.date },
        assignments: roster,
        nurses: roster.map((a) => this.nurses[this.nurseOf(a)]!),
        shiftTypes: [shift.shiftType],
      });
      const result = evaluateSchedule(
        view,
        this.ruleSet,
        { ...this.ctx, shiftTypes: [shift.shiftType] },
        { only: this.shiftHardIds },
      );
      for (const v of result.hardViolations) {
        const shortfall = v.details?.shortfall;
        hard += typeof shortfall === 'number' ? shortfall : 1;
      }
    }
    let soft = 0;
    if (shift.demand) {
      for (const role of NURSE_ROLES) {
        const target = shift.demand.byRole[role].targetCount;
        const staffed = this.staffed(shift, role);
        if (staffed < target) soft += (target - staffed) * this.weights.targetShortfall;
        else if (staffed > target) soft += (staffed - target) * this.weights.overTarget;
      }
    }
    return hard * this.weights.hardShortfall + soft;
  }

  private hoursPenaltyFor(n: number): number {
    return this.hoursShort(n) * this.weights.underHours;
  }

  private fairness(): number {
    if (this.teamShare <= 0) return 0;
    const weights = this.ruleSet.fairnessWeights;
    let total = 0;
    for (const component of BURDEN_COMPONENTS) {
      const w = weights[component];
      if (w <= 0) continue;
      let teamTotal = 0;
      for (const i of this.candidates) {
        if (this.shareWeight[i]! > 0) teamTotal += this.carried(i, component);
      }
      if (teamTotal <= 0) continue;
      for (const i of this.candidates) {
        const share = this.shareWeight[i]!;
        if (share <= 0) continue;
        const over = this.carried(i, component) - (teamTotal * share) / this.teamShare;
        if (over > 0) total += w * over;
      }
    }
    return total * this.weights.fairness;
  }

  private carried(n: number, component: BurdenComponent): number {
    return this.histCarried[n]![component] + this.current(n, component);
  }

  /** This period's counter for a burden component, from the incrementally maintained tallies. */
  private current(n: number, component: BurdenComponent): number {
    switch (component) {
      case 'nights':
        return this.nights[n]!;
      case 'weekends':
        return this.weekendKeys[n]!.size;
      case 'holidays':
        return this.holidays[n]!;
      case 'onCall':
        return this.onCall[n]!;
      case 'undesirable':
        return this.undesirable[n]!;
      case 'overtime':
        return Math.max(0, this.workedHours[n]! - this.contractedProRata[n]!);
    }
  }

  // ---------------------------------------------------------------------------
  // Per (nurse, shift) tables, filled lazily
  // ---------------------------------------------------------------------------

  private tableKey(n: number, shift: Shift): number {
    return n * this.shifts.length + shift.idx;
  }

  /** A throwaway view of this nurse on this shift, for the ledger's own definitions. */
  private viewFor(n: number, shift: Shift): AssignmentView {
    const nurse = this.nurses[n]!;
    return {
      assignment: {
        id: 'probe',
        periodId: this.input.period.id,
        nurseId: nurse.id,
        shiftTypeId: shift.shiftType.id,
        date: shift.date,
        source: 'solver',
        isLocked: false,
        isCharge: false,
        isOvertime: false,
      },
      nurse,
      shiftType: shift.shiftType,
      window: shiftWindow(shift.date, shift.shiftType),
      paidHours: shift.shiftType.durationHours,
      inPeriod: true,
    };
  }

  isUndesirable(n: number, shift: Shift): boolean {
    const key = this.tableKey(n, shift);
    const cached = this.undesirableCache.get(key);
    if (cached !== undefined) return cached;
    const prefs = this.input.preferences.filter((p) => p.nurseId === this.nurses[n]!.id);
    const value = isUndesirable(this.viewFor(n, shift), prefs, this.ctx.weekendDefinition);
    this.undesirableCache.set(key, value);
    return value;
  }

  /**
   * Preference weight this shift runs against, seniority-scaled. An imposition (`avoid_*`,
   * a weekend for someone who wants none) costs the full weight; a missed `prefer_*` costs
   * half — not getting the shift you like is milder than getting the one you asked not to.
   * Block-length preferences are not priced: they are a property of the whole timeline, not
   * of one shift, and the fairness ledger already scores them after the fact.
   */
  preferencePenalty(n: number, shift: Shift): number {
    const key = this.tableKey(n, shift);
    const cached = this.prefCache.get(key);
    if (cached !== undefined) return cached;
    const nurse = this.nurses[n]!;
    const st = shift.shiftType;
    let penalty = 0;
    if (!st.isOnCall) {
      const weekday = weekdayOf(shift.date);
      const weekend = isWeekendWindow(shiftWindow(shift.date, st), this.ctx.weekendDefinition);
      for (const pref of this.input.preferences) {
        if (pref.nurseId !== nurse.id) continue;
        switch (pref.kind) {
          case 'avoid_shift_type':
            if (pref.shiftTypeId === st.id) penalty += pref.weight;
            break;
          case 'prefer_shift_type':
            if (pref.shiftTypeId !== st.id) penalty += pref.weight / 2;
            break;
          case 'avoid_weekday':
            if (pref.weekday === weekday) penalty += pref.weight;
            break;
          case 'prefer_weekday':
            if (pref.weekday !== weekday) penalty += pref.weight / 2;
            break;
          case 'weekend_appetite':
            if (pref.level < 0 && weekend) penalty += pref.weight * -pref.level;
            break;
          case 'preferred_block_length':
            break;
        }
      }
    }
    const value = penalty * this.seniority[n]!;
    this.prefCache.set(key, value);
    return value;
  }

  /**
   * Straight-time dollars for this nurse on this shift, priced by the cost module on a
   * one-shift timeline. Weekly overtime cannot be attributed per shift and is kept out of the
   * schedule by the hard weekly-hours rule instead; the charge differential is ignored because
   * every worked shift carries exactly one charge nurse regardless of who it is.
   */
  /** Straight-time dollars for this nurse on this shift; 0 without pay data. */
  shiftCostFor(n: number, shift: Shift): number {
    return this.shiftCost(n, shift, this.viewFor(n, shift).assignment);
  }

  private shiftCost(n: number, shift: Shift, a: Assignment): number {
    if (!this.costCtx) return 0;
    const key = this.tableKey(n, shift);
    const cached = this.costCache.get(key);
    if (cached !== undefined) return cached;
    const nurse = this.nurses[n]!;
    const view = new ScheduleView({
      period: this.input.period,
      assignments: [{ ...a, isCharge: false }],
      nurses: [nurse],
      shiftTypes: [shift.shiftType],
    });
    const value = costNurse(view, this.costCtx, nurse.id).reduce((sum, c) => sum + c.total, 0);
    this.costCache.set(key, value);
    return value;
  }

  // ---------------------------------------------------------------------------
  // Snapshots and output
  // ---------------------------------------------------------------------------

  snapshot(): Snapshot {
    return this.unlocked.map((a) => ({ ...a }));
  }

  /** Put the schedule back to a snapshot: every unlocked assignment out, the snapshot's in. */
  restore(snapshot: Snapshot): void {
    for (const a of [...this.unlocked]) this.remove(a);
    for (const a of snapshot) this.add({ ...a });
  }

  /** Locked originals plus the solver's own, sorted and renumbered for a stable output. */
  assignments(): Assignment[] {
    const all: Assignment[] = [];
    for (const list of this.byNurse) all.push(...list);
    const order = new Map(this.shiftTypes.map((s, i) => [s.id, i]));
    all.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (order.get(a.shiftTypeId) ?? 0) - (order.get(b.shiftTypeId) ?? 0) ||
        a.nurseId.localeCompare(b.nurseId),
    );
    let seq = 0;
    return all.map((a) => (a.isLocked ? a : { ...a, id: `solver-${++seq}` }));
  }
}

function spliceOut<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i === -1) throw new Error('Solver state corrupted: assignment not found where expected');
  list.splice(i, 1);
}
