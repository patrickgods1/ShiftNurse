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
 *   (i.e. FTE) **× exposure**, never to the hours they actually worked. Exposure is the pay
 *   periods she was there for: each period's available days (approved leave and days before
 *   the hire date taken out), weighted 0.5 per 180 days of age and forgotten after 365, so a
 *   new hire, a nurse back from FMLA and a veteran are compared by *rate*, not by how many
 *   ledger rows each happens to have. If the share were based on worked hours, giving a nurse
 *   one more night shift would also raise their share of nights, and in the edge case of a
 *   nurse who works nothing but nights the extra shift would *improve* their relative
 *   standing. Contract and exposure read leave, hire date and history, never the assignment
 *   being judged, which is what keeps the score monotone: a worse assignment never raises it.
 * - **Deviation** is `(carried − fairShare) / fairShare`, so `+0.5` reads "50% over share".
 *   Under-share is favourable to the nurse and is clamped to a perfect component score.
 * - The **burden index** is signed: positive means the nurse has carried more than their share
 *   and is owed relief; the solver prefers to hand the next undesirable shift to the most
 *   negative index. Preference and time-off equity enter with the same sign convention
 *   (behind the team → positive).
 * - Seniority is a multiplier on the solver's preference price, never on the displayed score:
 *   a senior nurse's unmet preference is honoured sooner, but the same burden reads the same
 *   for everyone. It is never an override either: no amount of seniority moves a night shift
 *   off the books.
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
  overtime: 'Hours over contract',
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
  periodDays: 0,
  availableDays: 0,
});

/**
 * What `deriveCounters` needs beyond the schedule. Deliberately narrower than `RuleContext`
 * so the historical-schedule importer can derive ledger rows for a period that has no
 * demand table, credentials or time-off on record.
 */
export interface CounterContext {
  unit: Unit;
  holidayDates: ReadonlySet<IsoDate>;
  /**
   * Holiday id → date, which a `holiday_appetite` preference needs to be scored. Required so no
   * builder can forget it: a missing map would read every holiday-work wish as out of period and
   * give a denied volunteer a full preference mark.
   */
  holidayDateById: ReadonlyMap<Id, IsoDate>;
  weekendDefinition: WeekendDefinition;
  preferences: readonly Preference[];
  /**
   * Approved/denied tallies count requests whose `startDate` falls in the period; availability
   * counts every approved request overlapping it.
   */
  timeOff?: readonly TimeOffRequest[];
}

/** Decay-weighted totals over a window: counters with no period of their own. */
export type CarriedCounters = Omit<BurdenCounters, 'periodDays' | 'availableDays'>;

/** Which ledger counter each burden component reads. */
export const BURDEN_COUNTER: Record<BurdenComponent, keyof CarriedCounters> = {
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

/** Which period is being scored, which every age and every pro-rata share is measured from. */
export interface BurdenScope {
  /** First day of the period being scored. Only history rows starting before it count. */
  asOf: IsoDate;
  /** Days in the period being scored. A nurse missing from `current` was available for all of
   * them and worked none. */
  periodDays: number;
  /** The unit's pay period: `contractedHoursPerPeriod` is per pay period (root CLAUDE.md). */
  payPeriodDays: number;
}

export interface BurdenOptions {
  /** History rows whose midpoint is more than this many days before `asOf` are ignored. */
  windowDays: number;
  /**
   * A row's weight halves every this many days between its midpoint and `asOf`, so last
   * month's holiday weighs more than one from a year ago. `Infinity` disables decay.
   */
  halfLifeDays: number;
  weights: FairnessWeights;
}

/**
 * A year matches the look-back of holiday rotation and `weekends_off_per_year`, and fits inside
 * the 400 days the loaders read.
 */
export const DEFAULT_BURDEN_OPTIONS: BurdenOptions = {
  windowDays: 365,
  halfLifeDays: 180,
  weights: DEFAULT_FAIRNESS_WEIGHTS,
};

/** One nurse's standing relative to the team, per component and in total. */
export interface NurseBurden {
  nurseId: Id;
  /** Age-weighted sum of ledger counters across the window, plus the current period. */
  carried: CarriedCounters;
  /**
   * The basis for this nurse's fair share per pay period available: `contractedHoursPerPeriod`,
   * or, with no contracted hours (per-diem, agency), her historical hours per pay period
   * available. Zero means no basis at all.
   */
  shareWeight: number;
  /** Pay periods available: age-weighted available days over the current period and history,
   * divided by the unit's pay period. */
  exposure: number;
  /** `shareWeight × exposure`, rounded to hundredths. Fair share is proportional to it. */
  fairWeight: number;
  /** Per burden component, `teamTotal × fairWeight / teamFairWeight`; 0 when not comparable. */
  fairShare: Record<BurdenComponent, number>;
  /** `fairWeight > 0`. False = every burden component reads as neutral. */
  comparable: boolean;
  /** Per component, `(carried − fairShare) / fairShare`; equity components use `(team − nurse)`. */
  deviation: Record<FairnessComponent, number>;
  /**
   * Weighted sum of deviations, each burden's over-share bounded as `x / (1 + x)` so one holiday
   * on a large team cannot swamp every other component. Positive = owed relief.
   */
  index: number;
  /** Ledger periods that contributed, most recent first. Zero means "no history". */
  periodsInWindow: number;
  /** True when anything contributed — history or the current period. False = no record at all. */
  hasRows: boolean;
  /** True when any contributing period had a day available, so preferences could be judged. */
  hasPreferenceRecord: boolean;
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
  /** The component's fairness weight, so the breakdown sums to the composite transparently. */
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

/**
 * The dates behind a nurse's burden counters for the period scored. `nights` is per shift's
 * start date, matching `nightShifts`. `holidays` lists the holiday dates the shifts worked under
 * the unit's `holidayAttribution` (D18), not their start dates: by the clock the Christmas Eve
 * night lists Christmas, and a night spanning two holidays lists both while `holidaysWorked`
 * counts it once. `weekends` is per weekend *day* worked, whereas `weekendsWorked` counts
 * distinct weekends (Sat + Sun = 1).
 */
export interface NurseOccurrences {
  nights: IsoDate[];
  weekends: IsoDate[];
  holidays: IsoDate[];
}

export interface NurseFairnessScore {
  nurseId: Id;
  /** In-period dates of nights, weekend days and holidays worked; empty when not supplied. */
  occurrences: NurseOccurrences;
  /** 0–100 composite: weighted mean of the component scores. */
  score: number;
  components: ComponentScore[];
  /** The seniority multiplier the solver applies to this nurse's preference price; shown, not
   * scored. */
  seniorityMultiplier: number;
  /** Signed burden index over history *plus* this period; what the solver reads. */
  burdenIndex: number;
  /** False when the nurse has no fair weight, so burden components were neutral. */
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
  /** How many nurses were included (excluded nurses have no fair weight). */
  count: number;
}

export interface UnitDistribution {
  /** Over the per-nurse composite scores. */
  score: DistributionStats;
  /**
   * Over each component's per-nurse *rate* among comparable nurses — carried ÷ fair share for
   * burdens (1.00 = exactly fair; 1 for everyone when the team carried none), the raw rate for
   * equity — so that a 0.5 FTE nurse with half the nights of a full-timer reads as even, not
   * as under-burdened.
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
  /** The dates behind `current`, from `deriveOccurrences`; absent nurses get empty lists. */
  occurrences?: ReadonlyMap<Id, NurseOccurrences>;
  /** Historical ledger rows, any order; the window and decay are applied inside. */
  history: readonly FairnessLedgerEntry[];
  /** The period `current` covers: what ages and pro-rata shares are measured from. */
  scope: BurdenScope;
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
 * Imported shifts bucketed into pay periods (anchored on the unit's `payPeriodAnchor`). The
 * ledger keeps imported history per pay period and app history per schedule period, and weighs
 * each by the days it covers. `periodId` is synthetic — `import:<start>` — because the
 * ledger's `periodId` has no foreign key precisely so history can predate the app.
 */
export interface HistoricalPeriod {
  periodId: Id;
  start: IsoDate;
  end: IsoDate;
  rows: HistoricalShiftRow[];
}
