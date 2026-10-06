/**
 * The solver's contract — what goes in, what comes out, and how a caller watches it run.
 *
 * ## Why an interface
 *
 * The shipped solver is a local-search engine (greedy seed, then simulated annealing with a
 * ruin-and-recreate neighbourhood) written in plain TypeScript so nothing extra has to be
 * bundled with the desktop app. It is not the last word: a unit that outgrows it will want a
 * CP-SAT backend, and that has to be a swap of one implementation behind `Solver`, not a
 * rewrite of the Generate flow, the worker plumbing or the report screen. Everything those
 * touch is defined here in plain data.
 *
 * ## Why the input is plain data
 *
 * `SolveInput` deliberately holds rows, not `RuleContext`, `DemandTable` or `ScheduleView`. The
 * desktop app runs the solver in a worker thread and the future server will run it in a
 * separate process; both receive the input by structured clone or JSON. The solver builds
 * its own indexes from the rows, using exactly the same `buildRuleContext` / `deriveDemand`
 * pipeline the grid's validation uses, so the schedule it emits is judged by the same
 * machinery that will judge it on screen.
 *
 * ## What "never violates a hard rule" means here
 *
 * The solver treats the two rule scopes differently (see `RuleScope`):
 *
 * - **Nurse-scope hard rules are absolute.** A shift is only ever added to a nurse's timeline
 *   if that timeline, with the shift, passes every enabled hard nurse-scope rule. There is one
 *   deliberate exception: `under_contracted_hours` is a *floor*, reached by construction and
 *   pushed toward by the objective; it cannot gate an addition, because every schedule starts
 *   empty and every nurse starts under hours. It is reported at the end like any other residual.
 * - **Shift-scope hard rules are priced, not gated.** Understaffing, a missing charge nurse, an
 *   all-novice roster or a missing credential can be impossible to fix — there may simply not
 *   be enough eligible nurses. Refusing to emit a schedule would leave the manager with nothing;
 *   emitting the best legal-per-nurse schedule and listing exactly what is still short is what
 *   the resolution flow (M10) builds on. Those residuals are the `unfilled` list.
 *
 * So the guarantee is: every nurse's timeline is legal; every shortfall is named.
 */

import type { ShiftDemand } from '../acuity/demand.js';
import type { ScheduleCost } from '../cost/types.js';
import type {
  Assignment,
  AvailabilityBlock,
  Credential,
  Differential,
  FairnessLedgerEntry,
  Holiday,
  Id,
  IncompatibilityGroup,
  Nurse,
  NurseCredential,
  OvertimeRule,
  OvertimeVolunteer,
  PayRate,
  Preceptorship,
  Preference,
  RatioRole,
  RestWaiver,
  SchedulePeriod,
  ShiftCredentialRequirement,
  ShiftType,
  TimeOffRequest,
  Unit,
} from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import type { FairnessReport } from '../fairness/types.js';
import type { PaidSickCall } from '../rules/paid-leave.js';
import type { HolidayWorkRecord, RuleSet, Violation } from '../rules/types.js';
import type { ScheduleDigest } from './digest.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Pay data, when the caller wants dollars in the objective and in the report. */
export interface SolveCostInput {
  payRates: readonly PayRate[];
  differentials: readonly Differential[];
  overtimeRules: readonly OvertimeRule[];
}

export interface SolveInput {
  unit: Unit;
  period: SchedulePeriod;
  /** The rule set the period was created under — never "latest". */
  ruleSet: RuleSet;
  /** The whole roster; inactive nurses are kept only for the locked shifts they already hold. */
  nurses: readonly Nurse[];
  shiftTypes: readonly ShiftType[];
  /** Derived demand for every date in the period, from `deriveDemand(...).all()`. */
  demand: readonly ShiftDemand[];
  /**
   * The period's current assignments. Locked ones are preserved exactly; the rest are the
   * previous draft and are discarded before solving (the manager's pins are the only thing
   * that carries over — that is what a lock is for).
   */
  assignments: readonly Assignment[];
  /** The published lookback tail, so rest and weekly-hours rules see across the boundary. */
  priorAssignments: readonly Assignment[];
  timeOff: readonly TimeOffRequest[];
  /**
   * Missed shifts paid from sick leave whose assignment is off the schedule: credited toward
   * contracted hours, as approved paid leave in `timeOff` is.
   */
  paidSickCalls?: readonly PaidSickCall[];
  /** Nurses who should not be on the floor together; absent means none. */
  incompatibilityGroups?: readonly IncompatibilityGroup[];
  credentials: readonly Credential[];
  nurseCredentials: readonly NurseCredential[];
  shiftCredentialRequirements: readonly ShiftCredentialRequirement[];
  holidays: readonly Holiday[];
  /** Who worked each past holiday, for the holiday rotation. Absent: nobody is owed one. */
  holidayWork?: readonly HolidayWorkRecord[];
  /** Standing offers to work overtime, for the no-mandatory-overtime rule. */
  overtimeVolunteers?: readonly OvertimeVolunteer[];
  /** Orientees and their preceptors, for the orientee-with-preceptor rule. */
  preceptorships?: readonly Preceptorship[];
  /** Written waivers of minimum rest, by nurse and the date of the shift they excuse. Absent: none. */
  restWaivers?: readonly RestWaiver[];
  /** Recurring windows a nurse cannot work (accommodations), hard. Absent: none. */
  availabilityBlocks?: readonly AvailabilityBlock[];
  preferences: readonly Preference[];
  /** Ledger rows strictly before this period, for the burden index the seed and objective read. */
  ledgerHistory: readonly FairnessLedgerEntry[];
  cost?: SolveCostInput;
}

// ---------------------------------------------------------------------------
// Objective
// ---------------------------------------------------------------------------

/**
 * How much each concern counts, in one common unit of "points". The defaults are ordered so
 * that a genuine staffing gap dominates everything, a nurse's contracted hours come next (both
 * are hard rules, but a shift below its floor is a safety problem while a nurse a shift short
 * of contract is a grievance — 3000 against 480, more than any fairness swing),
 * nurses the manager keeps apart come next (a whole shared 12 costs 600, above a nurse's shift
 * of contracted hours, so the solver will rather leave someone a shift short than pair them),
 * an unfilled soft target beats fairness, and fairness beats preference and money — but the
 * ratios are deliberately not extreme, so a $600 difference or a badly skewed night count can
 * still move a decision between two otherwise-equal candidates.
 */
export interface ObjectiveWeights {
  /** Per nurse short of a shift's hard minimum, or per shift-scope hard violation. */
  hardShortfall: number;
  /** Per nurse short of a shift's soft target. */
  targetShortfall: number;
  /** Per nurse above a shift's soft target: surplus hours have to land somewhere, but spread. */
  overTarget: number;
  /** Per hour a nurse is short of their contracted hours in a pay period. */
  underHours: number;
  /**
   * Per hour, per member of an incompatibility group on the floor beyond the group's cap, while
   * that rule is soft. A hard incompatibility rule — the outside-staff buffer, or the cap when a
   * rule set makes it hard — costs `hardShortfall` per missing (or excess) person per 12 hours.
   */
  incompatibility: number;
  /**
   * Scales the fairness term: weighted sum of positive burden deviations (carried minus fair
   * share, linear).
   */
  fairness: number;
  /** Per unit of preference weight (1–5, seniority-scaled) an assignment runs against. */
  preference: number;
  /**
   * Per holiday-rotation breach while that rule is soft: a worked shift on a holiday the nurse
   * worked last year, or one nurse on both halves of a paired minor/major holiday. Counted in
   * the fairness bucket of the breakdown. Above a strong preference (5 × 10), below an unfilled
   * target, so the rotation gives way before a shift goes short.
   */
  holidayRotation: number;
  /**
   * Per day or evening shift a nurse works too soon after nights, while the days-off-after-
   * nights rule is soft. Counted with preferences: it is about the nurse, not the unit. Below a
   * holiday breach and an unfilled target, above most single preferences, so the solver keeps a
   * rotation steady unless that leaves something short.
   */
  nightRecovery: number;
  /**
   * Per worked shift inside a time-off request still waiting for a decision, while that rule is
   * soft. Above any single preference (5 × 10) — the nurse has asked for the day, not merely
   * leaned against it — and far below an hour of contract or a short shift, so a day asked off
   * gives way before anyone is left short. Counted with preferences.
   */
  pendingTimeOff: number;
  /**
   * Per weekend-pattern breach while that rule is soft: a weekend ending too long a run, or one
   * over the per-schedule limit. Counted in the fairness bucket. Just above a strong preference
   * (5 × 10) and just below a holiday-rotation breach.
   */
  weekendPattern: number;
  /** Per dollar of straight-time cost. */
  cost: number;
}

export const DEFAULT_OBJECTIVE_WEIGHTS: ObjectiveWeights = {
  hardShortfall: 3000,
  targetShortfall: 60,
  overTarget: 8,
  underHours: 40,
  incompatibility: 50,
  fairness: 30,
  preference: 10,
  holidayRotation: 55,
  nightRecovery: 45,
  pendingTimeOff: 80,
  weekendPattern: 50,
  cost: 0.05,
};

/** The objective, itemised so the report can say where the points went. */
export interface ObjectiveBreakdown {
  total: number;
  coverage: number;
  /** Incompatible staff on the floor together, and without enough outside staff. */
  incompatibility: number;
  hours: number;
  fairness: number;
  preferences: number;
  cost: number;
}

// ---------------------------------------------------------------------------
// Options, progress, cancellation
// ---------------------------------------------------------------------------

export interface SolveProgress {
  /** 0–1. */
  fraction: number;
  /** `searching` is CP-SAT's search, which reports objective and bound but no iterations. */
  phase: 'seeding' | 'annealing' | 'searching' | 'finishing';
  iteration: number;
  maxIterations: number;
  /** Best objective found so far. */
  best: number;
  /** Current objective (may be worse than best mid-anneal). */
  current: number;
  /**
   * Nurse-slots still short of a hard minimum in the best schedule so far. Absent while CP-SAT
   * searches: its progress carries objective values, not schedules.
   */
  hardShortfall?: number;
  /** CP-SAT's proven lower bound on the objective so far. */
  bound?: number;
  elapsedMs: number;
}

export interface SolveOptions {
  /** Same seed, same input, same schedule. */
  seed: number;
  /**
   * Annealing budget. Determinism holds when the run is bounded by iterations alone: a
   * wall-clock limit stops at whatever iteration the clock happened to reach.
   */
  maxIterations: number;
  /** Safety valve. Leave unset for a reproducible run. */
  timeLimitMs?: number;
  weights?: Partial<ObjectiveWeights>;
  onProgress?: (progress: SolveProgress) => void;
  /** How often `onProgress` fires during annealing. */
  progressEveryIterations?: number;
  /** Polled between iterations; a `true` ends the run with the best schedule so far. */
  shouldCancel?: () => boolean;
  /** Clock for elapsed time and the time limit. Injectable so tests never wait. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One role on one shift that the solver could not bring up to its hard minimum. */
export interface UnfilledSlot {
  date: IsoDate;
  shiftTypeId: Id;
  /** A role, or `licensed` for a short RN + LPN pool. */
  role: RatioRole;
  required: number;
  staffed: number;
  shortfall: number;
  /** Which standard is short: the contractual floor or the legal patient ratio. */
  standard: 'coverage_floor' | 'ratio';
}

/**
 * The selectable backends (M15). `sa-lns` is pure TypeScript and always available; `cp-sat` and
 * `hybrid` need the OR-Tools runner, which lives in the desktop main process, not here.
 */
export type SolverId = 'hybrid' | 'sa-lns' | 'cp-sat';

export interface SolveStats {
  /** The backend that actually produced this schedule, after any fallback. */
  solver: SolverId;
  /** Set when the requested backend could not run and another took its place. */
  fellBackFrom?: { solver: SolverId; reason: string };
  /** Best proven lower bound on the objective, from exact backends. */
  bound?: number;
  /** Relative optimality gap, `(objective - bound) / objective`; 0 means proven optimal. */
  gap?: number;
  seed: number;
  iterations: number;
  /** Moves the annealer accepted, including uphill ones. */
  accepted: number;
  /** Times a new best was found. */
  improvements: number;
  elapsedMs: number;
  cancelled: boolean;
  /** True when the wall-clock limit, not the iteration budget, ended the run. */
  timedOut: boolean;
  /** Objective after the greedy seed, before annealing. */
  seedObjective: number;
  /** Hybrid only: CP-SAT windows attempted, and how many improved the schedule. */
  windows?: { tried: number; improved: number };
}

export interface SolveReport {
  /** The proposed in-period schedule, locked assignments echoed with their original ids. */
  assignments: Assignment[];
  /** Roles on shifts still below their hard minimum. Empty means every floor is met. */
  unfilled: UnfilledSlot[];
  /** Full-engine evaluation of the result under the period's rule set. */
  hardViolations: Violation[];
  softViolations: Violation[];
  objective: ObjectiveBreakdown;
  fairness: FairnessReport;
  /** The schedule in a manager's terms: nights and weekends spread, quick flips, short hours. */
  digest: ScheduleDigest;
  /** Present when `SolveInput.cost` was given. */
  cost?: ScheduleCost;
  stats: SolveStats;
}

export interface Solver {
  readonly name: SolverId;
  solve(input: SolveInput, options: SolveOptions): SolveReport;
}
