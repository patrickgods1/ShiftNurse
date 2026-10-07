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
import { costNurse, isBaylorPlan } from '../cost/cost.js';
import type { CostContext } from '../cost/types.js';
import type {
  Assignment,
  Id,
  IncompatibilityGroup,
  Nurse,
  NurseRole,
  SchedulePeriod,
  ShiftType,
} from '../domain/entities.js';
import {
  addDays,
  datesInRange,
  dayNumber,
  type IsoDate,
  isWeekendWindow,
  type ShiftWindow,
  shiftWindow,
  weekdayOf,
  weekendKey,
} from '../domain/time.js';
import { isUndesirable } from '../fairness/ledger.js';
import { seniorityMultipliers } from '../fairness/seniority.js';
import { BURDEN_COMPONENTS, type BurdenComponent } from '../fairness/types.js';
import { approvedLeaveOn } from '../rules/availability-rules.js';
import {
  type HolidayRotationFacts,
  holidayRotationFacts,
  holidayRotationRule,
  inHolidayRotation,
  workedInHistory,
} from '../rules/holiday-rotation.js';
import {
  type ContractedHoursParams,
  contractedHoursRule,
  type MaxHoursParams,
  maxHoursRule,
} from '../rules/hours-rules.js';
import {
  groupsForPeriod,
  incompatibleBufferRule,
  incompatibleTogetherRule,
  judgeFloor,
  type OnFloor,
} from '../rules/incompatibility-rules.js';
import { nightRecoveryRule } from '../rules/night-recovery.js';
import { pendingRequestOn, pendingTimeOffRule } from '../rules/pending-time-off.js';
import {
  buildRuleContext,
  evaluatePrepared,
  getRule,
  hardRuleIdsByScope,
  type PreparedRule,
  paramsOf,
  prepareRules,
  requireParams,
  resolveConfigs,
} from '../rules/registry.js';
import type { RuleContext, RuleSet, RuleSeverity, Violation } from '../rules/types.js';
import {
  judgesWeekends,
  type WeekendPatternParams,
  weekendBreaches,
  weekendPatternRule,
} from '../rules/weekend-pattern.js';
import { coveringShift } from '../schedule/cover.js';
import { workedHours } from '../schedule/holdover.js';
import { floorSegments } from '../schedule/overlap.js';
import { type AssignmentView, ScheduleView } from '../schedule/view.js';
import {
  buildShifts,
  costContextFor,
  historyFairness,
  hoursBuckets,
  workCalendar,
} from './model-setup.js';
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

/**
 * A stretch of the floor covered by the same shifts throughout — what incompatible staff are
 * priced over. Only built when the period has incompatibility groups.
 */
export interface FloorStretch {
  idx: number;
  hours: number;
  /** Model shifts whose hours cover the whole stretch. */
  shifts: Shift[];
  /** Published lookback rows covering it: a night begun the evening before the period. */
  tail: Assignment[];
}

/** What `add` needs to hand back so `undoAdd` can restore caches without re-evaluating. */
export interface AddToken {
  coverageBefore: number;
  hoursBefore: number;
  recoveryBefore: number;
  weekendBefore: number;
  /** The coverage of the shifts inside this one, in `innerShifts` order, when it has any. */
  innerBefore?: readonly number[];
  /** The incompatibility price of the stretches this shift covers, in `stretchesOf` order. */
  stretchesBefore?: readonly number[];
}

/** Priced over overlapping rosters by their own term, not on one shift's roster. */
const INCOMPATIBILITY_RULE_IDS = new Set([incompatibleTogetherRule.id, incompatibleBufferRule.id]);

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
  /** `shiftOf` runs on every move; a linear search per call was measurable in a solve. */
  private readonly shiftTypeById: ReadonlyMap<Id, ShiftType>;
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
  private readonly incompat: number[];
  private incompatSum = 0;
  private prefSum = 0;
  private costSum = 0;
  /** Holiday-rotation breaches as the schedule stands (see `holidayRotationFacts`). */
  private holidaySum = 0;
  /** Per nurse: day-side shifts worked too soon after nights (see `night-recovery.ts`). */
  private readonly recovery: number[];
  private recoverySum = 0;
  /** Worked shifts inside a pending time-off request (see `pending-time-off.ts`). */
  private pendingSum = 0;
  /** Per nurse: weekend-pattern breaches (see `weekend-pattern.ts`). */
  private readonly weekendPenalty: number[];
  private weekendSum = 0;

  // --- Per-nurse counters feeding fairness and hours ---------------------------
  private readonly workedHours: number[];
  private readonly bucketHours: number[][];
  private readonly nights: number[];
  private readonly holidays: number[];
  private readonly onCall: number[];
  private readonly undesirable: number[];
  private readonly weekendKeys: Map<string, number>[];
  /** shift × role → nurses of that role on the roster. `staffed` is asked for every shift and
   * role on every move (coverage, `shortShifts`); counting the roster each time was a fifth of
   * a solve. */
  private readonly staffedByRole: number[];
  /** `fairness()` reads every nurse's counters; they change only in `count`, which clears this. */
  private fairnessCache: number | undefined;
  /** Candidates with a fair share, in candidate order — the only nurses fairness sums over. */
  private readonly sharers: readonly number[];
  private readonly fairnessScratch: number[];
  /** nurse × date → assignments starting that day. O(1) "is this nurse free that day". */
  private readonly onDate: number[][];
  /** nurse × date → on approved leave. Leave never changes during a solve. */
  private readonly onLeave: boolean[][];
  /** nurse × work week → hours that count toward the weekly cap, lookback tail included. */
  private readonly weekHours: number[][];
  /**
   * nurse × overtime window → hours that count toward the overtime threshold, lookback tail
   * included. The window is the work week, or the pay period when the rule set judges overtime
   * over the pay period; kept apart from `weekHours` because the weekly cap binds either way.
   */
  private readonly overtimeHours: number[][];
  /**
   * nurse × overtime window → paid leave that counts toward the overtime threshold (never the
   * cap). All zero unless the rule set counts leave toward overtime.
   */
  readonly overtimeLeaveHours: number[][];

  // --- Precomputed inputs ----------------------------------------------------
  // Public and read-only so the CP-SAT encoder (cpsat/) reads the same tables instead of
  // re-deriving pay-period buckets, fair shares or preference weights a second way.
  readonly nurseHardIds: readonly string[];
  readonly shiftHardIds: readonly string[];
  private readonly baselineViolations: number[];
  // The gate's fixed inputs, built once: the hard rules of each scope, one rule context per
  // nurse and per shift type, one single-day period per shift. Rebuilding them on every check
  // (a spread of the context, a resolve of the rule set) was a fifth of a solve.
  private readonly nurseRules: readonly PreparedRule[];
  private readonly shiftRules: readonly PreparedRule[];
  private readonly nurseCtx: RuleContext[] = [];
  private readonly shiftCtx = new Map<ShiftType, RuleContext>();
  private readonly shiftPeriod: SchedulePeriod[] = [];
  /**
   * shift index → the shift covering it: in the model, or (a night begun the day before the
   * period) the tail's roster of it. Undefined for a standalone shift.
   */
  readonly coverShift: (
    | { shiftType: ShiftType; shift: Shift }
    | { shiftType: ShiftType; tail: readonly Assignment[] }
    | undefined
  )[];
  /** shift index → the shifts inside it. */
  private readonly innerShifts: Shift[][];
  /** Groups that can apply to a shift in the period; empty when neither rule is priced. */
  readonly incompatibilityGroups: readonly IncompatibilityGroup[];
  /**
   * Points per person-hour: `excess` for a member beyond the cap, `shortfall` for missing
   * outside staff; each `hardShortfall / 12` when its rule is hard, `incompatibility` when
   * soft, 0 when disabled.
   */
  readonly incompatibilityPrice: { excess: number; shortfall: number; minOutsideStaff: number };
  readonly stretches: readonly FloorStretch[];
  /** shift index → the stretches it covers. A change to the shift re-prices exactly these. */
  private readonly stretchesOf: FloorStretch[][];
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
  /** date index → overtime-window index, counted from the window containing the first day. */
  private readonly overtimeOfDate: number[];
  private readonly overtimeOf: (date: IsoDate) => number;
  private readonly overtimeCount: number;
  private readonly overtimeThreshold: number;
  readonly histCarried: Record<BurdenComponent, number>[];
  readonly shareWeight: number[];
  readonly teamShare: number;
  readonly seniority: number[];
  /** What the holiday rotation owes and pairs for this period; empty while the rule is off. */
  readonly holidayFacts: HolidayRotationFacts;
  /** Points per breach: the weight while the rule is soft; 0 when hard (the gate keeps breaches
   * out) or off. */
  readonly holidayPrice: number;
  /** Whole days off owed after a night before a day-side shift; 0 while the rule is off. */
  readonly recoveryDays: number;
  /** Points per day-side shift too soon after nights; 0 unless the rule is soft. */
  readonly recoveryPrice: number;
  /** Points per worked shift inside a pending request; 0 unless that rule is soft. */
  readonly pendingPrice: number;
  /** The weekend-pattern limits while that rule is on; undefined while it is off. */
  readonly weekendParams: WeekendPatternParams | undefined;
  /** Points per weekend-pattern breach; 0 unless that rule is soft. */
  readonly weekendPrice: number;
  /** Per nurse: weekends worked in the lookback tail, which start a run. */
  private readonly priorWeekends: ReadonlySet<IsoDate>[];
  /** nurse × date index → the date falls inside a pending request of theirs. */
  private readonly pendingOn: boolean[][];
  /** nurse × date index → worked night shifts / worked day-side shifts on that date. */
  private readonly nightsOn: number[][];
  private readonly daySideOn: number[][];
  /** Per nurse: lookback nights still owed days off, as days before the period's first day. */
  private readonly priorNightOffsets: number[][];
  /** nurse → holiday dates in the period they are owed off. */
  private readonly owedOffDates: (ReadonlySet<IsoDate> | undefined)[];
  /** date → the pair sides that fall on it (pair index, 0 minor / 1 major). */
  private readonly pairSidesOn = new Map<IsoDate, { pair: number; side: 0 | 1 }[]>();
  /** nurse × (pair · 2 + side) → worked shifts on that date, lookback tail included. */
  private readonly pairWork: number[][];
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
      ...(input.paidSickCalls ? { paidSickCalls: input.paidSickCalls } : {}),
      ...(input.incompatibilityGroups
        ? { incompatibilityGroups: input.incompatibilityGroups }
        : {}),
      ...(input.holidayWork ? { holidayWork: input.holidayWork } : {}),
      ...(input.overtimeVolunteers ? { overtimeVolunteers: input.overtimeVolunteers } : {}),
      ...(input.preceptorships ? { preceptorships: input.preceptorships } : {}),
      ...(input.restWaivers ? { restWaivers: input.restWaivers } : {}),
      ...(input.availabilityBlocks ? { availabilityBlocks: input.availabilityBlocks } : {}),
    });

    const shifts = buildShifts(this.dates, this.shiftTypes, demand);
    this.shifts = shifts;
    this.solvableShifts = shifts.filter((s) => s.solvable);

    // A shift inside another is judged with the containing shift's roster as cover, so a change
    // to the containing shift re-prices the ones inside it (`refresh`).
    const shiftTypesById = new Map(this.shiftTypes.map((t) => [t.id, t]));
    this.shiftTypeById = shiftTypesById;
    this.innerShifts = shifts.map(() => []);
    this.coverShift = shifts.map((shift) => {
      const cover = coveringShift(shift.shiftType, shift.date, shiftTypesById);
      if (!cover) return undefined;
      const dateIdx = this.dateIdx.get(cover.date);
      if (dateIdx === undefined) {
        // The night that began the day before the period: its roster is the published tail.
        const tail = input.priorAssignments.filter(
          (a) => a.date === cover.date && a.shiftTypeId === cover.shiftType.id,
        );
        return { shiftType: cover.shiftType, tail };
      }
      const outer = this.shiftAt(dateIdx, cover.shiftType);
      this.innerShifts[outer.idx]!.push(shift);
      return { shiftType: cover.shiftType, shift: outer };
    });

    this.nurseHardIds = hardRuleIdsByScope(input.ruleSet, 'nurse');
    this.shiftHardIds = hardRuleIdsByScope(input.ruleSet, 'shift').filter(
      (id) => !INCOMPATIBILITY_RULE_IDS.has(id),
    );
    this.nurseRules = prepareRules(input.ruleSet, this.nurseHardIds);
    this.shiftRules = prepareRules(input.ruleSet, this.shiftHardIds);

    const configs = resolveConfigs(input.ruleSet);

    // --- Incompatible staff: priced per stretch of floor, by the hour. ---
    const severityOf = (ruleId: string): RuleSeverity | null => {
      const config = configs.find((c) => c.ruleId === ruleId);
      if (!config?.enabled) return null;
      return config.severityOverride ?? getRule(ruleId)!.severity;
    };
    const perHour = (severity: RuleSeverity | null) =>
      severity === null
        ? 0
        : severity === 'hard'
          ? this.weights.hardShortfall / 12
          : this.weights.incompatibility;
    const bufferSeverity = severityOf(incompatibleBufferRule.id);
    const bufferParams = paramsOf(incompatibleBufferRule, configs);
    this.incompatibilityPrice = {
      excess: perHour(severityOf(incompatibleTogetherRule.id)),
      shortfall: perHour(bufferSeverity),
      minOutsideStaff: bufferSeverity === null ? 0 : (bufferParams?.minOutsideStaff ?? 0),
    };
    // --- Holiday rotation: which holidays each nurse is owed off, which dates are paired. ---
    const rotationSeverity = severityOf(holidayRotationRule.id);
    this.holidayFacts =
      rotationSeverity === null
        ? { owedOff: new Map(), pairs: [] }
        : holidayRotationFacts(this.ctx, requireParams(holidayRotationRule, configs), {
            start: input.period.startDate,
            end: input.period.endDate,
          });
    this.holidayPrice = rotationSeverity === 'soft' ? this.weights.holidayRotation : 0;
    // --- Days off after nights: priced while soft; a hard rule is the gate's to enforce. ---
    const recoverySeverity = severityOf(nightRecoveryRule.id);
    const recoveryParams = paramsOf(nightRecoveryRule, configs);
    this.recoveryDays =
      recoverySeverity === null
        ? 0
        : Math.max(0, Math.floor(recoveryParams?.daysOffAfterNights ?? 0));
    this.recoveryPrice = recoverySeverity === 'soft' ? this.weights.nightRecovery : 0;
    this.pendingPrice =
      severityOf(pendingTimeOffRule.id) === 'soft' ? this.weights.pendingTimeOff : 0;
    // --- Weekends in a row and per schedule: priced while soft, gated while hard. ---
    const weekendSeverity = severityOf(weekendPatternRule.id);
    this.weekendParams =
      weekendSeverity === null ? undefined : paramsOf(weekendPatternRule, configs);
    this.weekendPrice = weekendSeverity === 'soft' ? this.weights.weekendPattern : 0;
    this.owedOffDates = this.nurses.map((nurse) => this.holidayFacts.owedOff.get(nurse.id));
    for (const [pair, { minor, major }] of this.holidayFacts.pairs.entries()) {
      for (const [side, date] of [minor.date, major.date].entries()) {
        const list = this.pairSidesOn.get(date) ?? [];
        list.push({ pair, side: side as 0 | 1 });
        this.pairSidesOn.set(date, list);
      }
    }

    const priced = this.incompatibilityPrice.excess > 0 || this.incompatibilityPrice.shortfall > 0;
    // The day before the period too: its night is on the floor on the first morning.
    this.incompatibilityGroups = priced
      ? groupsForPeriod(
          input.incompatibilityGroups ?? [],
          addDays(input.period.startDate, -1),
          input.period.endDate,
        )
      : [];
    this.stretches = this.buildStretches(shiftTypesById);
    this.stretchesOf = shifts.map(() => []);
    for (const stretch of this.stretches) {
      for (const shift of stretch.shifts) this.stretchesOf[shift.idx]!.push(stretch);
    }
    this.incompat = this.stretches.map(() => 0);
    this.fteParams = paramsOf(contractedHoursRule, configs) ?? contractedHoursRule.defaultParams;
    const maxHours = paramsOf(maxHoursRule, configs) ?? maxHoursRule.defaultParams;
    this.maxHoursParams = maxHours;
    const calendar = workCalendar(input, this.dates, maxHours);
    this.weekOf = calendar.weekOf;
    this.weekOfDate = calendar.weekOfDate;
    this.weekCount = calendar.weekCount;
    this.overtimeOf = calendar.overtimeOf;
    this.overtimeOfDate = calendar.overtimeOfDate;
    this.overtimeCount = calendar.overtimeCount;
    this.overtimeThreshold = calendar.overtimeThreshold;

    this.costCtx = costContextFor(input, this.ctx, maxHours);

    // --- Hours buckets: the complete pay periods the FTE rule judges, plus any remainder. ---
    const buckets = hoursBuckets(
      input,
      this.dates,
      this.dateIdx,
      this.nurses,
      this.fteParams,
      this.ctx,
    );
    this.bucketOfDate = buckets.bucketOfDate;
    const bucketCount = buckets.bucketCount;
    this.hoursTarget = buckets.hoursTarget;
    this.hoursCapped = buckets.hoursCapped;
    this.contractedProRata = buckets.contractedProRata;
    const n = this.nurses.length;

    // --- Historical burden, weighted exactly as computeBurden weights it under a current row. ---
    const activeNurses = this.candidates.map((i) => this.nurses[i]!);
    const history = historyFairness(this.nurses, activeNurses, input);
    this.histCarried = history.histCarried;
    this.shareWeight = history.shareWeight;
    this.teamShare = this.shareWeight.reduce((sum, w) => sum + w, 0);
    this.sharers = this.candidates.filter((i) => this.shareWeight[i]! > 0);
    this.fairnessScratch = new Array<number>(this.sharers.length).fill(0);

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
    this.overtimeHours = Array.from({ length: n }, () =>
      new Array<number>(this.overtimeCount).fill(0),
    );
    this.overtimeLeaveHours = this.nurses.map((nurse) => {
      const windows = new Array<number>(this.overtimeCount).fill(0);
      if (!maxHours.paidLeaveCountsTowardOvertime) return windows;
      for (const c of this.ctx.paidLeaveByNurse.get(nurse.id) ?? []) {
        const w = this.overtimeOf(c.date);
        if (w >= 0 && w < this.overtimeCount) windows[w]! += c.hours;
      }
      return windows;
    });
    for (const [i, list] of prior.entries()) {
      for (const a of list) {
        const st = this.shiftTypeById.get(a.shiftTypeId);
        if (!st || (st.isOnCall && !maxHours.onCallCountsTowardHours)) continue;
        const week = this.weekOf(a.date);
        // A lookback shift held over counts what was worked; in-period rows are drafts, which
        // never carry a holdover (only a draft is generated).
        const hours = workedHours(a, st);
        if (week >= 0 && week < this.weekCount) this.weekHours[i]![week]! += hours;
        const w = this.overtimeOf(a.date);
        if (w >= 0 && w < this.overtimeCount) this.overtimeHours[i]![w]! += hours;
      }
    }
    // The half of a pair already behind the period: worked in the lookback tail (Christmas Eve
    // last period), or on record however long ago (Memorial Day for a Thanksgiving pair).
    this.pairWork = this.nurses.map((nurse) =>
      this.holidayFacts.pairs.flatMap(({ minor, major }) =>
        [minor, major].map((h) =>
          workedInHistory(this.ctx, nurse.id, h, input.period.startDate) ? 1 : 0,
        ),
      ),
    );
    for (const [i, list] of prior.entries()) {
      for (const a of list) {
        const st = this.shiftTypeById.get(a.shiftTypeId);
        if (!st || st.isOnCall) continue;
        for (const { pair, side } of this.pairSidesOn.get(a.date) ?? []) {
          this.pairWork[i]![pair * 2 + side]! += 1;
        }
      }
    }
    this.nightsOn = Array.from({ length: n }, () => new Array<number>(this.dates.length).fill(0));
    this.daySideOn = Array.from({ length: n }, () => new Array<number>(this.dates.length).fill(0));
    const periodFirstDay = dayNumber(input.period.startDate);
    this.priorNightOffsets = prior.map((list) => {
      const offsets: number[] = [];
      for (const a of list) {
        const st = this.shiftTypeById.get(a.shiftTypeId);
        if (!st || st.isOnCall || !st.isNight) continue;
        const k = periodFirstDay - dayNumber(a.date);
        if (k >= 1 && k <= this.recoveryDays) offsets.push(k);
      }
      return offsets;
    });
    this.recovery = new Array<number>(n).fill(0);
    this.priorWeekends = prior.map((list) => {
      const keys = new Set<IsoDate>();
      for (const a of list) {
        const st = this.shiftTypeById.get(a.shiftTypeId);
        if (!st || st.isOnCall) continue;
        const key = weekendKey(shiftWindow(a.date, st), this.ctx.weekendDefinition);
        if (key !== null) keys.add(key as IsoDate);
      }
      return keys;
    });
    this.weekendPenalty = new Array<number>(n).fill(0);
    this.pendingOn = this.nurses.map((nurse) =>
      this.dates.map((date) => pendingRequestOn(this.ctx, nurse.id, date) !== undefined),
    );
    this.hoursPenalty = new Array<number>(n).fill(0);
    this.coverage = this.shifts.map(() => 0);
    this.staffedByRole = new Array<number>(this.shifts.length * NURSE_ROLES.length).fill(0);

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
    this.recoverySum = 0;
    this.weekendSum = 0;
    for (let i = 0; i < n; i++) {
      this.hoursPenalty[i] = this.hoursPenaltyFor(i);
      this.hoursSum += this.hoursPenalty[i]!;
      this.recovery[i] = this.recoveryFor(i);
      this.recoverySum += this.recovery[i]!;
      this.weekendPenalty[i] = this.weekendFor(i);
      this.weekendSum += this.weekendPenalty[i]!;
    }
    this.coverageSum = 0;
    for (const shift of this.shifts) {
      this.coverage[shift.idx] = this.coveragePenalty(shift);
      this.coverageSum += this.coverage[shift.idx]!;
    }
    this.incompatSum = 0;
    for (const stretch of this.stretches) {
      this.incompat[stretch.idx] = this.incompatibilityPenalty(stretch);
      this.incompatSum += this.incompat[stretch.idx]!;
    }
  }

  /**
   * The period's floor cut into stretches covered by the same shifts, inside the hours of the
   * period's own shifts. Only when there are groups to price: otherwise nothing reads them.
   */
  private buildStretches(shiftTypesById: ReadonlyMap<Id, ShiftType>): FloorStretch[] {
    if (this.incompatibilityGroups.length === 0) return [];
    type Item = { window: ShiftWindow; shift?: Shift; tail?: Assignment[] };
    const items: Item[] = [];
    for (const shift of this.shifts) {
      if (shift.shiftType.isOnCall) continue;
      items.push({ window: shiftWindow(shift.date, shift.shiftType), shift });
    }
    const within = items.map((item) => item.window);
    const tails = new Map<string, Item>();
    for (const a of this.input.priorAssignments) {
      const type = shiftTypesById.get(a.shiftTypeId);
      if (!type || type.isOnCall) continue;
      const key = `${a.date}|${a.shiftTypeId}`;
      const item = tails.get(key);
      if (item) item.tail!.push(a);
      else tails.set(key, { window: shiftWindow(a.date, type), tail: [a] });
    }
    items.push(...tails.values());
    return floorSegments(items, within).map((segment, idx) => ({
      idx,
      hours: (segment.endMinute - segment.startMinute) / 60,
      shifts: segment.on.flatMap((item) => (item.shift ? [item.shift] : [])),
      tail: segment.on.flatMap((item) => item.tail ?? []),
    }));
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
    const type = this.shiftTypeById.get(a.shiftTypeId);
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
    return this.staffedByRole[shift.idx * NURSE_ROLES.length + ROLE_INDEX[role]]!;
  }

  isOnDate(nurseIdx: number, dateIdx: number): boolean {
    return this.onDate[nurseIdx]![dateIdx]! > 0;
  }

  /** Solvable shifts with a role, or a licensed pool, below its hard minimum, in calendar order. */
  shortShifts(): Shift[] {
    return this.solvableShifts.filter((shift) => this.shortRoles(shift).length > 0);
  }

  /**
   * Roles that would close a hard shortfall on one shift: each role below its minimum, then —
   * when a licensed ratio's RN + LPN pool is short — the roles that fill it, LPN first so RNs
   * stay free for shifts only an RN can fill. No single role's minimum covers the pool, so
   * without naming it here the seed and the annealer's fill moves would never aim at it.
   */
  shortRoles(shift: Shift): NurseRole[] {
    if (!shift.demand) return [];
    const demand = shift.demand;
    const roles = NURSE_ROLES.filter(
      (role) => this.staffed(shift, role) < demand.byRole[role].minCount,
    );
    for (const role of this.poolRoles(shift)) if (!roles.includes(role)) roles.push(role);
    return roles;
  }

  /** The roles that fill a short licensed pool on this shift, LPN first; empty when it is not short. */
  poolRoles(shift: Shift): NurseRole[] {
    const pooled = shift.demand?.licensed?.ratioDerived ?? 0;
    if (pooled <= 0) return [];
    return this.staffed(shift, 'RN') + this.staffed(shift, 'LPN') < pooled ? ['LPN', 'RN'] : [];
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
      const hours = shift.shiftType.durationHours;
      const week = this.weekOfDate[shift.dateIdx]!;
      if (this.weekHours[nurseIdx]![week]! + hours > this.maxHoursParams.maxHoursPerWeek) {
        return false;
      }
      const w = this.overtimeOfDate[shift.dateIdx]!;
      if (
        this.maxHoursParams.requireOvertimeAuthorisation &&
        this.overtimeHours[nurseIdx]![w]! + hours + this.overtimeLeaveHours[nurseIdx]![w]! >
          this.overtimeThreshold
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

  /**
   * The hard nurse-scope violations (floors aside) that involve a locked shift, as the model
   * stands — on a fresh model, the pins alone. A CP-SAT model can only be infeasible because of
   * these: a locked shift is a constant there, where this model measures around it instead.
   */
  lockedHardViolations(): Violation[] {
    const breaches: Violation[] = [];
    for (let i = 0; i < this.nurses.length; i++) {
      const locked = new Set(this.byNurse[i]!.filter((a) => a.isLocked).map((a) => a.id));
      if (locked.size === 0) continue;
      for (const v of this.evaluateNurse(i, null).hardViolations) {
        if (FLOOR_CODES.has(v.code)) continue;
        if (v.assignmentIds.some((id) => locked.has(id))) breaches.push(v);
      }
    }
    return breaches;
  }

  private countHardViolations(nurseIdx: number, candidate: Assignment | null): number {
    let count = 0;
    for (const v of this.evaluateNurse(nurseIdx, candidate).hardViolations) {
      if (!FLOOR_CODES.has(v.code)) count++;
    }
    return count;
  }

  private evaluateNurse(nurseIdx: number, candidate: Assignment | null) {
    const nurse = this.nurses[nurseIdx]!;
    const own = this.byNurse[nurseIdx]!;
    const view = new ScheduleView({
      period: this.input.period,
      assignments: candidate ? [...own, candidate] : own,
      priorAssignments: this.prior[nurseIdx]!,
      nurses: [nurse],
      shiftTypes: this.shiftTypes,
    });
    let ctx = this.nurseCtx[nurseIdx];
    if (!ctx) {
      ctx = { ...this.ctx, nurses: [nurse] };
      this.nurseCtx[nurseIdx] = ctx;
    }
    return evaluatePrepared(view, this.nurseRules, ctx);
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
    const token = this.tokenFor(n, shift);
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
    const token = this.tokenFor(n, shift);
    this.refresh(n, shift);
    return token;
  }

  private tokenFor(n: number, shift: Shift): AddToken {
    const token: AddToken = {
      coverageBefore: this.coverage[shift.idx]!,
      hoursBefore: this.hoursPenalty[n]!,
      recoveryBefore: this.recovery[n]!,
      weekendBefore: this.weekendPenalty[n]!,
    };
    const inner = this.innerShifts[shift.idx]!;
    if (inner.length > 0) token.innerBefore = inner.map((s) => this.coverage[s.idx]!);
    const stretches = this.stretchesOf[shift.idx]!;
    if (stretches.length > 0) {
      token.stretchesBefore = stretches.map((s) => this.incompat[s.idx]!);
    }
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
    if (token.innerBefore) {
      for (const [i, inner] of this.innerShifts[shift.idx]!.entries()) {
        this.coverageSum += token.innerBefore[i]! - this.coverage[inner.idx]!;
        this.coverage[inner.idx] = token.innerBefore[i]!;
      }
    }
    if (token.stretchesBefore) {
      for (const [i, stretch] of this.stretchesOf[shift.idx]!.entries()) {
        this.incompatSum += token.stretchesBefore[i]! - this.incompat[stretch.idx]!;
        this.incompat[stretch.idx] = token.stretchesBefore[i]!;
      }
    }
    this.hoursSum += token.hoursBefore - this.hoursPenalty[n]!;
    this.hoursPenalty[n] = token.hoursBefore;
    this.recoverySum += token.recoveryBefore - this.recovery[n]!;
    this.recovery[n] = token.recoveryBefore;
    this.weekendSum += token.weekendBefore - this.weekendPenalty[n]!;
    this.weekendPenalty[n] = token.weekendBefore;
  }

  private refresh(n: number, shift: Shift): void {
    for (const s of [shift, ...this.innerShifts[shift.idx]!]) {
      const coverage = this.coveragePenalty(s);
      this.coverageSum += coverage - this.coverage[s.idx]!;
      this.coverage[s.idx] = coverage;
    }
    for (const stretch of this.stretchesOf[shift.idx]!) {
      const price = this.incompatibilityPenalty(stretch);
      this.incompatSum += price - this.incompat[stretch.idx]!;
      this.incompat[stretch.idx] = price;
    }
    const hours = this.hoursPenaltyFor(n);
    this.hoursSum += hours - this.hoursPenalty[n]!;
    this.hoursPenalty[n] = hours;
    const recovery = this.recoveryFor(n);
    this.recoverySum += recovery - this.recovery[n]!;
    this.recovery[n] = recovery;
    const weekend = this.weekendFor(n);
    this.weekendSum += weekend - this.weekendPenalty[n]!;
    this.weekendPenalty[n] = weekend;
  }

  /** Update every per-nurse counter and the preference/cost sums for one assignment. */
  private count(n: number, shift: Shift, a: Assignment, sign: 1 | -1): void {
    const st = shift.shiftType;
    this.fairnessCache = undefined;
    this.staffedByRole[shift.idx * NURSE_ROLES.length + ROLE_INDEX[this.nurses[n]!.role]]! += sign;
    this.onDate[n]![shift.dateIdx]! += sign;
    if (!st.isOnCall || this.maxHoursParams.onCallCountsTowardHours) {
      this.weekHours[n]![this.weekOfDate[shift.dateIdx]!]! += sign * st.durationHours;
      this.overtimeHours[n]![this.overtimeOfDate[shift.dateIdx]!]! += sign * st.durationHours;
    }
    if (st.isOnCall) {
      this.onCall[n]! += sign;
      if (this.fteParams.onCallCountsTowardHours) {
        this.bucketHours[n]![this.bucketOfDate[shift.dateIdx]!]! += sign * st.durationHours;
      }
    } else {
      this.workedHours[n]! += sign * st.durationHours;
      this.bucketHours[n]![this.bucketOfDate[shift.dateIdx]!]! += sign * st.durationHours;
      if (this.pendingOn[n]![shift.dateIdx]) this.pendingSum += sign;
      if (st.isNight) {
        this.nights[n]! += sign;
        this.nightsOn[n]![shift.dateIdx]! += sign;
      } else {
        this.daySideOn[n]![shift.dateIdx]! += sign;
      }
      if (this.ctx.holidayDates.has(shift.date)) this.holidays[n]! += sign;
      if (this.isUndesirable(n, shift)) this.undesirable[n]! += sign;
      if (this.ctx.holidayDates.has(shift.date)) this.countHolidayRotation(n, shift.date, sign);
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

  /** A worked shift on a holiday date: an owed-off breach, and the pair it may complete. */
  private countHolidayRotation(n: number, date: IsoDate, sign: 1 | -1): void {
    if (this.owedOffDates[n]?.has(date)) this.holidaySum += sign;
    const sides = this.pairSidesOn.get(date);
    if (!sides || !inHolidayRotation(this.nurses[n]!)) return;
    const work = this.pairWork[n]!;
    for (const { pair, side } of sides) {
      const both = () => (work[pair * 2]! > 0 && work[pair * 2 + 1]! > 0 ? 1 : 0);
      const before = both();
      work[pair * 2 + side]! += sign;
      this.holidaySum += both() - before;
    }
  }

  /** Holiday-rotation breaches as the schedule stands. */
  holidayBreaches(): number {
    return this.holidaySum;
  }

  /** Day-side shifts worked too soon after nights, as the schedule stands. */
  recoveryBreaches(): number {
    return this.recoverySum;
  }

  /** Weekend-pattern breaches, as the schedule stands. */
  weekendBreaches(): number {
    return this.weekendSum;
  }

  /**
   * One nurse's weekend-pattern breaches, counted by the rule's own `weekendBreaches`: each
   * in-period weekend ending too long a run, plus each weekend over the per-schedule limit, plus
   * each four-week window's excess.
   */
  private weekendFor(n: number): number {
    const params = this.weekendParams;
    if (!params || !judgesWeekends(this.nurses[n]!)) return 0;
    const inPeriod = new Set(this.weekendKeys[n]!.keys() as Iterable<IsoDate>);
    if (inPeriod.size === 0) return 0;
    const worked = new Set<IsoDate>([...this.priorWeekends[n]!, ...inPeriod]);
    const { runs, excess, windows } = weekendBreaches({ worked, inPeriod }, params);
    return runs.length + excess + windows.reduce((total, w) => total + w.excess, 0);
  }

  /** Worked shifts inside pending time-off requests, as the schedule stands. */
  pendingBreaches(): number {
    return this.pendingSum;
  }

  /** What working this shift costs for falling inside the nurse's pending request. */
  pendingPenaltyOf(n: number, shift: Shift): number {
    return !shift.shiftType.isOnCall && this.pendingOn[n]![shift.dateIdx] ? this.pendingPrice : 0;
  }

  /**
   * One nurse's day-side shifts that start within `recoveryDays` days after a night, counted as
   * `nightRecoveryRule` counts them: once per day-side shift however many nights precede it,
   * lookback nights included.
   */
  private recoveryFor(n: number): number {
    const days = this.recoveryDays;
    if (days === 0) return 0;
    const nights = this.nightsOn[n]!;
    const daySide = this.daySideOn[n]!;
    const prior = this.priorNightOffsets[n]!;
    let count = 0;
    for (let d = 0; d < daySide.length; d++) {
      if (daySide[d]! === 0) continue;
      let tooSoon = false;
      for (let gap = 1; gap <= days && !tooSoon; gap++) {
        const night = d - gap;
        tooSoon = night >= 0 ? nights[night]! > 0 : prior.includes(-night);
      }
      if (tooSoon) count += daySide[d]!;
    }
    return count;
  }

  /**
   * Exactly one charge nurse per worked shift when one is available — none on a shift run by
   * another's charge nurse. The first eligible, unlocked nurse on the roster gets it —
   * deterministic, and re-run after every change so a removed charge nurse hands the role to
   * whoever is left.
   */
  private ensureCharge(shift: Shift): void {
    if (shift.shiftType.isOnCall || shift.shiftType.withinShiftTypeId !== null) return;
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
      this.incompatSum +
      this.hoursSum +
      this.fairness() +
      this.holidaySum * this.holidayPrice +
      this.weekendSum * this.weekendPrice +
      this.recoverySum * this.recoveryPrice +
      this.pendingSum * this.pendingPrice +
      this.prefSum * this.weights.preference +
      this.costSum * this.weights.cost
    );
  }

  breakdown(): ObjectiveBreakdown {
    const coverage = this.coverageSum;
    const incompatibility = this.incompatSum;
    const hours = this.hoursSum;
    // The holiday rotation is fairness between nurses, so it is reported with it.
    const fairness =
      this.fairness() + this.holidaySum * this.holidayPrice + this.weekendSum * this.weekendPrice;
    // Days off after nights are about the nurse, so they are reported with preferences.
    const preferences =
      this.prefSum * this.weights.preference +
      this.recoverySum * this.recoveryPrice +
      this.pendingSum * this.pendingPrice;
    const cost = this.costSum * this.weights.cost;
    return {
      total: coverage + incompatibility + hours + fairness + preferences + cost,
      coverage,
      incompatibility,
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

  /** One stretch's cached incompatibility price in points, as it stands. */
  incompatibilityPenaltyOf(stretch: FloorStretch): number {
    return this.incompat[stretch.idx]!;
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
      // A licensed ratio's RN + LPN pool, which no single role's minimum covers — beyond the RNs
      // the share needs, counted above, as the ratio rule counts it.
      const licensed = shift.demand.licensed;
      if (licensed) {
        const rns = this.staffed(shift, 'RN');
        const short = Math.max(0, licensed.ratioDerived - rns - this.staffed(shift, 'LPN'));
        total += short - Math.min(short, Math.max(0, licensed.minRn - rns));
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
      let period = this.shiftPeriod[shift.idx];
      if (!period) {
        period = { ...this.input.period, startDate: shift.date, endDate: shift.date };
        this.shiftPeriod[shift.idx] = period;
      }
      let ctx = this.shiftCtx.get(shift.shiftType);
      if (!ctx) {
        ctx = { ...this.ctx, shiftTypes: [shift.shiftType] };
        this.shiftCtx.set(shift.shiftType, ctx);
      }
      const cover = this.coverShift[shift.idx];
      const onUnit =
        cover === undefined
          ? roster
          : [...roster, ...('tail' in cover ? cover.tail : this.byShift[cover.shift.idx]!)];
      const view = new ScheduleView({
        period,
        assignments: onUnit,
        nurses: onUnit.map((a) => this.nurses[this.nurseOf(a)]!),
        shiftTypes: cover === undefined ? [shift.shiftType] : [shift.shiftType, cover.shiftType],
      });
      const result = evaluatePrepared(view, this.shiftRules, ctx);
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

  /**
   * One stretch's price: every group's verdict on who is on the floor through it (`judgeFloor`,
   * the rules' own), per person-hour. The lookback tail is on the floor too; a stretch only
   * the tail makes wrong is a constant, as it is for CP-SAT.
   */
  private incompatibilityPenalty(stretch: FloorStretch): number {
    const floor: OnFloor[] = [];
    for (const shift of stretch.shifts) {
      for (const a of this.byShift[shift.idx]!) floor.push({ nurseId: a.nurseId, date: a.date });
    }
    for (const a of stretch.tail) floor.push({ nurseId: a.nurseId, date: a.date });
    if (floor.length < 2) return 0;
    const { excess, shortfall, minOutsideStaff } = this.incompatibilityPrice;
    let points = 0;
    for (const verdict of judgeFloor(floor, this.incompatibilityGroups, minOutsideStaff)) {
      points += verdict.excess * excess + verdict.shortfall * shortfall;
    }
    return points * stretch.hours;
  }

  private hoursPenaltyFor(n: number): number {
    return this.hoursShort(n) * this.weights.underHours;
  }

  private fairness(): number {
    this.fairnessCache ??= this.computeFairness();
    return this.fairnessCache;
  }

  /**
   * Runs after every move, so each component reads its counters once into a scratch array and
   * walks only the nurses who carry a share. Same terms, summed in the same order, as walking
   * every candidate and skipping the rest — the result is bit-identical, which determinism needs.
   */
  private computeFairness(): number {
    if (this.teamShare <= 0) return 0;
    const weights = this.ruleSet.fairnessWeights;
    const sharers = this.sharers;
    const carried = this.fairnessScratch;
    let total = 0;
    for (const component of BURDEN_COMPONENTS) {
      const w = weights[component];
      if (w <= 0) continue;
      let teamTotal = 0;
      for (let k = 0; k < sharers.length; k++) {
        const value = this.carried(sharers[k]!, component);
        carried[k] = value;
        teamTotal += value;
      }
      if (teamTotal <= 0) continue;
      for (let k = 0; k < sharers.length; k++) {
        const over = carried[k]! - (teamTotal * this.shareWeight[sharers[k]!]!) / this.teamShare;
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
      // A Baylor nurse's weekends and holidays are the plan, not a burden: as the ledger counts.
      case 'weekends':
        return isBaylorPlan(this.nurses[n]!) ? 0 : this.weekendKeys[n]!.size;
      case 'holidays':
        return isBaylorPlan(this.nurses[n]!) ? 0 : this.holidays[n]!;
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
      scheduledHours: shift.shiftType.durationHours,
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

const ROLE_INDEX = Object.fromEntries(NURSE_ROLES.map((role, i) => [role, i])) as Record<
  NurseRole,
  number
>;

function spliceOut<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i === -1) throw new Error('Solver state corrupted: assignment not found where expected');
  list.splice(i, 1);
}
