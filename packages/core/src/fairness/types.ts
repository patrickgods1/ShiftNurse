/**
 * Fairness — the shapes shared by ledger derivation, burden history, scoring and the
 * unit-level distribution.
 *
 * ## Why this module exists
 *
 * A schedule can be perfectly legal and still unfair: every hard rule satisfied while the same
 * three nurses take every holiday. Fairness is therefore not a rule — it is a *score*, per
 * nurse, that the solver pushes on and the manager can read. The score has to be explainable
 * component by component, because "your fairness score is 61" is not an answer a nurse
 * manager can give in a staff meeting; "you carried 12 nights against a fair share of 8" is.
 *
 * ## Sign and share conventions — read before adding a component
 *
 * - A nurse's **fair share** of a burden is proportional to their `contractedHoursPerPeriod`
 *   (i.e. FTE), never to the hours they actually worked. If the share were based on worked
 *   hours, giving a nurse one more night shift would also raise their share of nights, and
 *   in the edge case of a nurse who works nothing but nights the extra shift would *improve*
 *   their relative standing. Contracted hours are fixed with respect to the assignment being
 *   judged, which is what makes the score monotone: a worse assignment never raises it.
 * - **Deviation** is `(carried − fairShare) / fairShare`, so `+0.5` reads "50% over share".
 *   Under-share is favourable to the nurse and is clamped to a perfect component score.
 * - The **burden index** is signed: positive means the nurse has carried more than their share
 *   and is owed relief; the solver prefers to hand the next undesirable shift to the most
 *   negative index. Preference and time-off equity enter with the same sign convention
 *   (behind the team → positive).
 * - Seniority is a **multiplier on preference weight**, never an override: a senior nurse's
 *   unmet preference costs more in the objective and in their own score, but no amount of
 *   seniority moves a night shift off the books.
 */

import type {
  FairnessLedgerEntry,
  Id,
  Nurse,
  Preference,
  TimeOffRequest,
  Unit,
} from '../domain/entities.js';
import type { IsoDate, WeekendDefinition } from '../domain/time.js';

// ---------------------------------------------------------------------------
// Components and weights
// ---------------------------------------------------------------------------

/** Burdens where "more" is worse for the nurse and shares are compared against the team. */
export type BurdenComponent =
  | 'nights'
  | 'weekends'
  | 'holidays'
  | 'onCall'
  | 'undesirable'
  | 'overtime';

/** Rates where "less" is worse for the nurse: how often they got what they asked for. */
export type EquityComponent = 'preferences' | 'timeOff';

export type FairnessComponent = BurdenComponent | EquityComponent;

export const BURDEN_COMPONENTS: readonly BurdenComponent[] = [
  'nights',
  'weekends',
  'holidays',
  'onCall',
  'undesirable',
  'overtime',
];

export const EQUITY_COMPONENTS: readonly EquityComponent[] = ['preferences', 'timeOff'];

export const FAIRNESS_COMPONENTS: readonly FairnessComponent[] = [
  ...BURDEN_COMPONENTS,
  ...EQUITY_COMPONENTS,
];

/**
 * Relative importance of each component in the composite score and the burden index. These
 * are the "soft weights" the Rules screen edits; a weight of 0 removes a component from the
 * composite without hiding its breakdown.
 */
export type FairnessWeights = Record<FairnessComponent, number>;

/**
 * Weekend and holiday equity are the clauses that get grieved, so they lead. Overtime is
 * light: it is already policed by hard rules and a heavy weight here would double-count.
 */
export const DEFAULT_FAIRNESS_WEIGHTS: FairnessWeights = {
  nights: 2,
  weekends: 3,
  holidays: 3,
  onCall: 1.5,
  undesirable: 2,
  overtime: 0.5,
  preferences: 2,
  timeOff: 1.5,
};

export const FAIRNESS_COMPONENT_LABELS: Record<FairnessComponent, string> = {
  nights: 'Night shifts',
  weekends: 'Weekends worked',
  holidays: 'Holidays worked',
  onCall: 'On-call shifts',
  undesirable: 'Shifts against stated preferences',
  overtime: 'Overtime hours',
  preferences: 'Preferences honoured',
  timeOff: 'Time-off requests approved',
};

// ---------------------------------------------------------------------------
// Burden counters
// ---------------------------------------------------------------------------

/** One period's burden counters for one nurse: a ledger row without its identity columns. */
export type BurdenCounters = Omit<
  FairnessLedgerEntry,
  'id' | 'nurseId' | 'periodId' | 'periodStart'
>;

export const EMPTY_COUNTERS: Readonly<BurdenCounters> = Object.freeze({
  nightShifts: 0,
  weekendsWorked: 0,
  holidaysWorked: 0,
  onCallShifts: 0,
  undesirableShifts: 0,
  requestsApproved: 0,
  requestsDenied: 0,
  callOutsCovered: 0,
  totalHours: 0,
  overtimeHours: 0,
  preferenceHitRate: 0,
});

/**
 * What `deriveCounters` needs beyond the schedule. Deliberately narrower than `RuleContext`
 * so the historical-schedule importer can derive ledger rows for a period that has no
 * demand table, credentials or time-off on record.
 */
export interface CounterContext {
  unit: Unit;
  holidayDates: ReadonlySet<IsoDate>;
  weekendDefinition: WeekendDefinition;
  preferences: readonly Preference[];
  /** Requests whose `startDate` falls in the period feed the approved/denied tallies. */
  timeOff?: readonly TimeOffRequest[];
}

/** Which ledger counter each burden component reads. */
export const BURDEN_COUNTER: Record<BurdenComponent, keyof BurdenCounters> = {
  nights: 'nightShifts',
  weekends: 'weekendsWorked',
  holidays: 'holidaysWorked',
  onCall: 'onCallShifts',
  undesirable: 'undesirableShifts',
  overtime: 'overtimeHours',
};

// ---------------------------------------------------------------------------
// Seniority
// ---------------------------------------------------------------------------

export interface SeniorityOptions {
  /**
   * How much more a most-senior nurse's preference weighs than a least-senior one's.
   * `0.5` means the most senior nurse's preferences count 1.5×; everyone in between scales
   * linearly by seniority rank. Zero disables seniority weighting entirely.
   */
  boost: number;
}

export const DEFAULT_SENIORITY: SeniorityOptions = { boost: 0.5 };

// ---------------------------------------------------------------------------
// Historical burden
// ---------------------------------------------------------------------------

export interface BurdenOptions {
  /** How many most-recent ledger periods per nurse to consider. */
  windowPeriods: number;
  /**
   * Per-period geometric decay applied walking back from the most recent ledger period, so
   * last month's holiday weighs more than one from a year ago. `1` disables decay.
   */
  decay: number;
  weights: FairnessWeights;
}

export const DEFAULT_BURDEN_OPTIONS: BurdenOptions = {
  windowPeriods: 13,
  decay: 0.85,
  weights: DEFAULT_FAIRNESS_WEIGHTS,
};

/** One nurse's standing relative to the team, per component and in total. */
export interface NurseBurden {
  nurseId: Id;
  /** Decay-weighted sum of ledger counters across the window. */
  carried: BurdenCounters;
  /**
   * The basis for this nurse's fair share: `contractedHoursPerPeriod`, or their mean historical
   * `totalHours` when they have no contracted hours (per-diem, agency). Zero means the nurse
   * cannot be compared and every burden component reads as neutral.
   */
  shareWeight: number;
  /** Per component, `(carried − fairShare) / fairShare`; equity components use `(team − nurse)`. */
  deviation: Record<FairnessComponent, number>;
  /** Weighted sum of `deviation`. Positive = owed relief. */
  index: number;
  /** Ledger periods that contributed, most recent first. Zero means "no history". */
  periodsInWindow: number;
  /** True when anything contributed — history or the current period. False = no record at all. */
  hasRows: boolean;
}

export interface BurdenReport {
  byNurse: ReadonlyMap<Id, NurseBurden>;
  /** Nurses sorted by `index` descending — the most owed first. Ties broken by nurse id. */
  ranked: NurseBurden[];
  options: BurdenOptions;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ComponentScore {
  component: FairnessComponent;
  /** 0–100. 100 = at or under fair share (burden) or every request honoured (equity). */
  score: number;
  /** Effective weight after the seniority multiplier, so the breakdown sums transparently. */
  weight: number;
  /** What the nurse carried (burden) or achieved (equity rate, 0–1). */
  actual: number;
  /** Their fair share (burden) or the team rate (equity). */
  expected: number;
  /** Signed deviation as in {@link NurseBurden.deviation}. */
  deviation: number;
  /** Plain-language line for the breakdown UI, naming both numbers. */
  explanation: string;
}

export interface NurseFairnessScore {
  nurseId: Id;
  /** 0–100 composite: weighted mean of the component scores. */
  score: number;
  components: ComponentScore[];
  /** The seniority multiplier applied to this nurse's preference weight. */
  seniorityMultiplier: number;
  /** Signed burden index over history *plus* this period; what the solver reads. */
  burdenIndex: number;
  /** False when the nurse has no share weight, so burden components were neutral. */
  comparable: boolean;
}

export interface DistributionStats {
  /** 0 = perfectly even, 1 = one nurse carries everything. */
  gini: number;
  min: number;
  max: number;
  mean: number;
  /** `max − min`. */
  spread: number;
  /** How many nurses were included (excluded nurses have no share weight). */
  count: number;
}

export interface UnitDistribution {
  /** Over the per-nurse composite scores. */
  score: DistributionStats;
  /**
   * Over each component's per-nurse *rate* — carried ÷ share weight for burdens, the raw
   * rate for equity — so that a 0.5 FTE nurse with half the nights of a full-timer reads as
   * even, not as under-burdened.
   */
  components: Record<FairnessComponent, DistributionStats>;
}

export interface FairnessReport {
  scores: NurseFairnessScore[];
  distribution: UnitDistribution;
  weights: FairnessWeights;
}

export interface ScoreInput {
  nurses: readonly Nurse[];
  /** This period's counters per nurse, from `deriveCounters`. Missing nurses count as empty. */
  current: ReadonlyMap<Id, BurdenCounters>;
  /** Historical ledger rows, any order; the window and decay are applied inside. */
  history: readonly FairnessLedgerEntry[];
  preferences: readonly Preference[];
  weights?: FairnessWeights;
  burden?: Partial<Omit<BurdenOptions, 'weights'>>;
  seniority?: SeniorityOptions;
}

// ---------------------------------------------------------------------------
// Historical schedule import
// ---------------------------------------------------------------------------

/** One line of a historical schedule CSV: who worked what, when. */
export interface HistoricalShiftRow {
  employeeId: string;
  date: IsoDate;
  /** Matches `ShiftType.abbreviation`, case-insensitively. */
  shiftAbbreviation: string;
}

export interface HistoricalCsvError {
  /** 1-based line number in the file, header included. */
  line: number;
  message: string;
}

/**
 * Imported shifts bucketed into pay periods (anchored on the unit's `payPeriodAnchor`), the
 * granularity the ledger is kept at. `periodId` is synthetic — `import:<start>` — because the
 * ledger's `periodId` has no foreign key precisely so history can predate the app.
 */
export interface HistoricalPeriod {
  periodId: Id;
  start: IsoDate;
  end: IsoDate;
  rows: HistoricalShiftRow[];
}
