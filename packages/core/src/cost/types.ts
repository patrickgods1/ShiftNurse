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
 * - **Night and evening by the clock.** A `night` or `evening` differential with a `window` is
 *   earned by the shift's hours inside that daily window, not by `ShiftType.isNight`. Reaching
 *   `wholeShiftAtHours` in the window makes it a whole-shift differential like any other; short
 *   of it, only the in-window hours earn it, priced on the *base* rate and kept out of the running
 *   rate, so it neither compounds nor raises overtime.
 * - **Consecutive shifts** (`consecutive_shift`, UC–CNA Art. 14 § I.3) are a whole-shift
 *   differential earned by the run, not the shift: once a run of consecutive worked days (shifts
 *   dated on each, lookback included, standby not) holds more than `afterShifts` full shifts dated
 *   within the shift's own day and the `withinDays` before it, that shift and every later one in the
 *   run earn it until a day off. The contract speaks of 12-hour nurses, so only a shift scheduled
 *   for 12 hours or more counts as full.
 * - **Overtime** is itemised the way a payslip itemises it: every hour is paid at its straight
 *   rate (above), and hours past an {@link OvertimeRule} threshold earn an additional
 *   *premium* of `(multiplier − 1) × straight rate`. So an overtime hour on a holiday night
 *   earns the holiday and night premiums *and* half of that rate again — the multipliers
 *   compound, which is what "time-and-a-half on the holiday rate" means in a contract.
 * - **Overtime rules do not stack; they band.** An hour is overtime once, at the highest
 *   multiplier any active rule gives it. Every rule makes the *end* of a shift overtime from
 *   some hour on, so a shift's overtime is a run of bands: under California's 1.5× past 8 hours
 *   a day and 2× past 12, a 13-hour shift is 4 hours at 1.5× and 1 at 2× (two `overtime` lines),
 *   not 5 hours at whichever one rule pays more.
 * - **Daily overtime is judged per workday**: the shifts that start on a date, summed in order,
 *   so the second shift of a double is overtime from the first hour past the threshold. A night
 *   that runs past midnight belongs to the workday it started on.
 * - **Weekly overtime falls on the later shifts of the week**, and pay-period overtime on the
 *   later shifts of the pay period. The first `threshold` hours of the window are straight
 *   time, in chronological order, including hours carried in from the previous period's
 *   lookback tail; only shifts that push past the threshold carry overtime, and only the hours
 *   past it.
 * - **Seventh-day overtime** (`basis: 'seventh_day'`) applies to a shift on the last day of a
 *   work week when every day of that week was worked (lookback shifts count): California pays
 *   its first 8 hours at 1.5× (threshold 0) and the rest at 2× (threshold 8).
 * - **Overtime beyond the scheduled tour** (`basis: 'beyond_scheduled_tour'`) makes a shift's
 *   holdover overtime from `thresholdHours` past its scheduled end (VA–NNU Art. 14); a shift
 *   with no holdover, or one within the threshold (a grace period), earns none.
 * - **Overtime past consecutive hours** (`basis: 'consecutive'`) counts the hours on the clock
 *   since the nurse's stretch began (shifts with no break between them, lookback included) and
 *   makes those past `thresholdHours` overtime (38 U.S.C. § 7453(e)(1)): a 12 is 4 hours over 8,
 *   and an evening shift straight after a day shift is all overtime.
 * - **Overtime on a day beyond the scheduled days** (`basis: 'beyond_scheduled_days'`): within a
 *   work week the nurse's worked dates are counted in order, lookback included, and on each date
 *   past their `scheduledDaysPerWeek` the workday's hours past `thresholdHours` are overtime (IWC
 *   Wage Order 5 § 3(B)(8): past 8 on such a day is double time). No scheduled days, no overtime.
 * - **Overtime past hours in the weekend** (`basis: 'weekend'`): the hours inside each window of the
 *   unit's weekend definition are summed in order, a shift straddling its edge giving only its
 *   in-window hours (a Friday 19:00–07:00 gives Saturday's weekend 7), and those past
 *   `thresholdHours` are overtime (38 U.S.C. § 7456(b)(3)(A): a Baylor nurse past 24 hours between
 *   midnight Friday and midnight Sunday). Paid leave does not count; `pyramiding` is honoured.
 * - **Daily premiums need not pyramid into weekly overtime.** A weekly or pay-period rule with
 *   `pyramiding: 'none'` counts only each shift's straight hours, lookback shifts included: those
 *   before any other basis makes it overtime (Cal. Lab. Code § 510; UC–CNA Art. 14 §M). Its
 *   overtime falls on the last straight hours, just before the daily premium ones. Absent,
 *   every worked hour counts.
 * - **Overtime too short to pay** (`minimumMinutes`) is dropped per rule per shift: under VA's 15
 *   minutes, that rule prices the shift as straight time. Another rule may still reach the hours.
 * - **Premiums add instead of compounding** under `CostContext.premiumStacking: 'additive'`: each
 *   multiplier adds `base × (multiplier − 1)` an hour and each overtime band's premium is
 *   `base × (multiplier − 1)`. So the straight rate is `base + Σflat + base × Σ(multiplier − 1)`
 *   (UC–CNA Art. 14 §N; Title 38 percentages of basic pay). Absent, `'compound'` as above.
 * - **Holiday pay covers holiday overtime** under `CostContext.holidayPayCoversOvertime`: an
 *   overtime hour that is paid the holiday or major-holiday premium gets no overtime premium,
 *   though it still counts in `overtimeHours` for alerts and the ledger (38 U.S.C. § 7453(g): no
 *   overtime pay on a holiday in addition to holiday pay). That is every hour of an ordinary
 *   holiday shift, but only the held hours of a Baylor tour, which is paid no holiday premium
 *   itself (§ 7456(d)). Absent, the overtime premium is paid on holiday hours too.
 * - **Overtime rules may be for one kind of nurse.** A rule with `scheduleKinds` prices only the
 *   nurses of those kinds (`Nurse.scheduleKind`, absent `'standard'`), so a unit's 72/80 and
 *   Baylor rules sit beside its standard ones (38 U.S.C. §§ 7456(c), 7456A(c)).
 * - **A daily rule may judge only tour days, or only the others.** `tourDays: 'only'` counts the
 *   workdays holding a tour, `'except'` the rest; a 72/80 nurse is over past 12 on a tour day and
 *   past 8 on any other (§ 7456A(c)(1)). A 72/80 tour day holds a shift scheduled for 12 hours; a
 *   Baylor one is a Saturday, a Sunday or a Friday whose shift runs into Saturday, pickups included,
 *   so only a Baylor weekday is judged past 8 (§ 7456(b)(3)(A)).
 * - **A Baylor tour earns no § 7453 premium.** A `va_baylor` nurse's regularly scheduled 12 (not
 *   `isOvertime`) on Saturday, Sunday or a Friday night (`isBaylorTour`) gets no night, evening, weekend or holiday pay on its
 *   scheduled hours (§ 7456(d)); charge and agency still apply. Its holdover earns them, on the
 *   base rate and out of the running rate, as partial clock differentials are.
 * - **A holdover is worked time on every basis.** It lengthens the shift's paid hours, so daily,
 *   weekly and pay-period overtime count it like any other hour.
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
import type { PaidLeaveCredit } from '../rules/paid-leave.js';

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
  /**
   * The major ones among `holidayDates`. A shift on one earns the `major_holiday` premium when
   * the unit has one, instead of the `holiday` premium; absent, every holiday is priced alike.
   */
  majorHolidayDates?: ReadonlySet<IsoDate>;
  weekendDefinition: WeekendDefinition;
  /** The contract's work-week start for weekly overtime, matching the max-hours rule. */
  workWeekStartsOn: Weekday;
  /**
   * Paid leave that counts toward overtime, by nurse (`RuleContext.paidLeaveByNurse`). Present
   * only when the rule set's max-hours rule says leave counts; absent, leave never moves a shift
   * into overtime. Each weekly or pay-period window starts its running hours with the leave
   * dated in it.
   */
  overtimeLeave?: ReadonlyMap<Id, readonly PaidLeaveCredit[]>;
  /**
   * How multiplier differentials and the overtime premium combine. `'compound'` (absent) is the
   * FLSA regular rate: `(base + Σflat) × Πmultiplier`, overtime on that. `'additive'` takes each
   * multiplier and each overtime premium on the base alone: UC–CNA Art. 14 §N forbids
   * duplication, pyramiding or compounding of premiums, and Title 38 pays differentials as
   * percentages of basic pay. Standby and partial clock-window differentials are priced on the
   * base either way.
   */
  premiumStacking?: 'compound' | 'additive';
  /**
   * Holiday pay already covers overtime worked on the holiday. 38 U.S.C. § 7453(d) pays holiday
   * service "including overtime service" at double pay, and § 7453(g) forbids overtime pay on top
   * of it, so a VA shift that earns the holiday premium adds no overtime premium. Absent/false:
   * overtime is paid on holiday hours as well, which is the FLSA regular rate.
   */
  holidayPayCoversOvertime?: boolean;
}

/** A unit's pay settings that are not rates, differentials or overtime rules. */
export interface PaySettings {
  /** The fewest hours a call-back pays, from the contract. 0 pays the hours worked. */
  callBackMinimumHours: number;
  /** How multiplier differentials and overtime combine; see `CostContext.premiumStacking`. */
  premiumStacking: 'compound' | 'additive';
  /**
   * Holiday pay already covers overtime worked on the holiday (38 U.S.C. § 7453(g)): a shift
   * that earns the holiday or major-holiday premium adds no overtime premium. Absent/false:
   * overtime is paid on holiday hours too, as the FLSA regular rate does.
   */
  holidayPayCoversOvertime: boolean;
}

/** What a unit that has never saved pay settings runs: no call-back minimum, FLSA stacking. */
export const DEFAULT_PAY_SETTINGS: PaySettings = {
  callBackMinimumHours: 0,
  premiumStacking: 'compound',
  holidayPayCoversOvertime: false,
};

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
  'evening',
  'weekend',
  'holiday',
  'major_holiday',
  'consecutive_shift',
  'charge',
  'on_call',
  'call_back',
  'agency',
];

export const COST_LINE_LABELS: Record<CostLineKind, string> = {
  base: 'Base pay',
  night: 'Night differential',
  evening: 'Evening differential',
  weekend: 'Weekend differential',
  holiday: 'Holiday premium',
  major_holiday: 'Major holiday premium',
  consecutive_shift: 'Consecutive-shift premium',
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
  /**
   * Dollars per hour before overtime: `(base + Σflat) × Πmultiplier`, or under additive stacking
   * `base + Σflat + base × Σ(multiplier − 1)`.
   */
  straightRate: number;
  /** Attributed even when the assignment is unpriced (`rateSource: 'none'`); only the dollars are 0. */
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
