/**
 * Cost — the shapes shared by rate resolution, schedule costing and budget comparison.
 *
 * ## Why this module exists
 *
 * Every scheduling decision has a dollar consequence, and most of them are invisible until
 * payroll runs: the "quick fix" of asking the same full-timer to cover one more shift is a
 * 1.5× overtime shift; the charge nurse you moved to the holiday night is now stacking three
 * differentials. Without a costing pass a manager only learns the price of a schedule from the
 * budget report a month later. With it, the grid, the solver and the day-of console can all
 * say "this option costs $312 more than that one" before anyone commits.
 *
 * ## The pay model — read before changing any arithmetic
 *
 * Each worked assignment is priced from a **base hourly rate** ({@link resolvePayRate}) and the
 * differentials that apply to it:
 *
 * - **Flat differentials** (`mode: 'flat'`) add dollars per hour to the base. Night, weekend
 *   and charge premiums are normally flat.
 * - **Multiplier differentials** (`mode: 'multiplier'`) scale the rate *after* the flats have
 *   been added: `(base + Σflat) × Πmultiplier`. This is the FLSA "regular rate" treatment —
 *   a shift differential is part of the rate a premium multiplies, not something added on top
 *   of it. Holiday premiums are normally multipliers.
 * - **Overtime** is itemised the way a payslip itemises it: every hour is paid at its straight
 *   rate (above), and hours past an {@link OvertimeRule} threshold earn an additional
 *   *premium* of `(multiplier − 1) × straight rate`. So an overtime hour on a holiday night
 *   earns the holiday and night premiums *and* half of that rate again — the multipliers
 *   compound, which is what "time-and-a-half on the holiday rate" means in a contract.
 * - **Daily and weekly overtime do not stack.** An hour is overtime once. When both kinds of
 *   rule are active, each assignment is priced under whichever rule yields the larger premium
 *   for it.
 * - **Weekly overtime falls on the later shifts of the week.** The first `threshold` hours of a
 *   work week are straight time, in chronological order, including hours carried in from the
 *   previous period's lookback tail; only shifts that push past the threshold carry overtime,
 *   and only the hours past it.
 * - **On-call standby** is not worked time: it earns the `on_call` differential alone (a flat
 *   amount per standby hour, or a multiplier on the base rate), never base pay, never other
 *   differentials, and never overtime. `call_back` — being called in while on standby — is
 *   a day-of event and is priced when the day-of console records one.
 * - **Agency nurses** (`employmentType: 'agency'`) earn the `agency` differential on every
 *   worked shift. An agency's all-in bill rate is best entered as that nurse's per-nurse pay
 *   rate with the agency differential at `multiplier 1.0`; the differential exists for units
 *   whose contracts express the premium as a percentage instead.
 * - **Holiday** follows the fairness convention: a shift is a holiday shift when its *start*
 *   date is a holiday. The night shift into a holiday morning is not one.
 *
 * An assignment whose nurse has no resolvable rate is **unpriced**: it contributes $0 and is
 * counted in `unpricedAssignments`. A cost report must display that count prominently — a
 * silent $0 is exactly the "plausible but wrong number" this codebase is built to avoid.
 */

import type {
  Assignment,
  Differential,
  DifferentialKind,
  Id,
  OvertimeRule,
  PayRate,
  Unit,
} from '../domain/entities.js';
import type { IsoDate, Weekday, WeekendDefinition } from '../domain/time.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** What costing needs beyond the schedule. Loaded once per call by whoever owns the data. */
export interface CostContext {
  unit: Unit;
  /** Every rate that might apply: per-nurse rows for this unit's nurses plus the role defaults. */
  payRates: readonly PayRate[];
  /** Active differentials only. */
  differentials: readonly Differential[];
  /** Active overtime rules only. Empty means no overtime is ever priced. */
  overtimeRules: readonly OvertimeRule[];
  holidayDates: ReadonlySet<IsoDate>;
  weekendDefinition: WeekendDefinition;
  /** The contract's work-week start for weekly overtime, matching the max-hours rule. */
  workWeekStartsOn: Weekday;
}

// ---------------------------------------------------------------------------
// Per-assignment costing
// ---------------------------------------------------------------------------

export type CostLineKind = 'base' | DifferentialKind | 'overtime';

/**
 * Fixed itemisation order. Multiplier lines are itemised as the increment each one adds to
 * the running rate, so their per-line amounts depend on order; pinning it keeps two costings
 * of the same shift byte-identical.
 */
export const DIFFERENTIAL_ORDER: readonly DifferentialKind[] = [
  'night',
  'weekend',
  'holiday',
  'charge',
  'on_call',
  'call_back',
  'agency',
];

export const COST_LINE_LABELS: Record<CostLineKind, string> = {
  base: 'Base pay',
  night: 'Night differential',
  weekend: 'Weekend differential',
  holiday: 'Holiday premium',
  charge: 'Charge differential',
  on_call: 'On-call standby',
  call_back: 'Call-back',
  agency: 'Agency premium',
  overtime: 'Overtime premium',
};

export interface CostLine {
  kind: CostLineKind;
  /** Hours this line applies to. Overtime lines cover only the overtime hours. */
  hours: number;
  /** Dollars per hour for this line alone. */
  rate: number;
  amount: number;
}

/** Where the base rate came from. `'none'` means the assignment is unpriced. */
export type RateSource = 'nurse' | 'role' | 'none';

export interface AssignmentCost {
  assignmentId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  hours: number;
  baseRate: number;
  rateSource: RateSource;
  /** Dollars per hour before overtime: `(base + Σflat) × Πmultiplier`. */
  straightRate: number;
  overtimeHours: number;
  lines: CostLine[];
  total: number;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface CostTotals {
  hours: number;
  overtimeHours: number;
  base: number;
  /** Every differential line, including on-call standby. */
  differentials: number;
  overtimePremium: number;
  total: number;
  byKind: Record<CostLineKind, number>;
}

export interface NurseCost extends CostTotals {
  nurseId: Id;
  assignments: number;
  /** Assignments that could not be priced because the nurse has no rate. */
  unpricedAssignments: number;
}

export interface NurseOvertime {
  nurseId: Id;
  hours: number;
  premium: number;
  /** This nurse's fraction of the unit's overtime hours, 0–1. */
  share: number;
}

/**
 * How concentrated overtime is. Total overtime is a budget number; *who* carries it is a
 * burnout and grievance number — six nurses splitting 48 hours is a different unit from one
 * nurse carrying all of it.
 */
export interface OvertimeConcentration {
  totalHours: number;
  totalPremium: number;
  /** Nurses with any overtime, most hours first; ties broken by nurse id. */
  ranked: NurseOvertime[];
  nursesWithOvertime: number;
  /** Share of overtime hours carried by the top three nurses. 0 when there is none. */
  topThreeShare: number;
  /** Gini over overtime hours across every nurse with an in-period assignment. 0 = spread evenly. */
  gini: number;
}

export interface ScheduleCost {
  periodId: Id;
  /** In-period assignments only, in schedule order. */
  assignments: AssignmentCost[];
  /** One entry per nurse with at least one in-period assignment, most expensive first. */
  nurses: NurseCost[];
  totals: CostTotals;
  unpricedAssignments: number;
  /** Nurses with at least one unpriced assignment. */
  unpricedNurseIds: Id[];
  overtime: OvertimeConcentration;
}

// ---------------------------------------------------------------------------
// Candidate pricing
// ---------------------------------------------------------------------------

/** The dollar impact of adding one assignment to a schedule, overtime interactions included. */
export interface MarginalCost {
  candidate: Assignment;
  /** The candidate priced in context, including any overtime it triggers. */
  cost: AssignmentCost;
  /**
   * Change in the nurse's period total. Can exceed `cost.total`: a shift that pushes the
   * week past the threshold can also turn an *earlier* shift's hours into overtime under a
   * weekly rule when it lands before them chronologically.
   */
  delta: number;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetVariance {
  targetDollars: number;
  actualDollars: number;
  /** `actual − target`; positive means over budget. */
  variance: number;
  /** `actual ÷ target`; `null` when the target is zero. */
  ratio: number | null;
}
