/**
 * Burden — how much of the team's undesirable-shift load each nurse has carried, as a rate per
 * day she was there, across an age-decayed ledger history plus (optionally) the period being
 * scored right now.
 *
 * This is the one place that turns raw counters into a *fair share*, so `score.ts` (the
 * per-nurse breakdown), both solvers, the conflicts engine and day-of ranking agree by
 * construction instead of re-deriving the same proportional split and drifting apart. See
 * `types.ts` for why fair share is pinned to `contractedHoursPerPeriod` rather than hours
 * actually worked — this module never reads worked hours to decide who "should" carry more.
 *
 * ## The rate model (D15)
 *
 * Summing ledger rows by position made fairness a count of rows: a new hire with none read as
 * owing the team's whole history, a nurse back from FMLA read as having dodged the nights she
 * was not there for (29 CFR 825.220(c) forbids exactly that), and imported fortnights decayed
 * three times as fast as six-week app periods. So each row is weighed by its age in days and by
 * the days the nurse was available in it, and her fair share grows with that exposure. A
 * zero-availability row adds nothing to any sum, so leave neither raises nor lowers anyone.
 *
 * A row's age is measured from its *midpoint*, not its start, so a six-week row and the three
 * fortnights covering the same days weigh the same in total.
 *
 * Fair weights are rounded to hundredths so CP-SAT can carry them as exact integers and the
 * Fairness page, SA and CP-SAT price the same number.
 */

import type { FairnessLedgerEntry, Id, Nurse } from '../domain/entities.js';
import { compareDates, dayNumber, type IsoDate } from '../domain/time.js';
import {
  BURDEN_COMPONENTS,
  BURDEN_COUNTER,
  type BurdenComponent,
  type BurdenCounters,
  type BurdenOptions,
  type BurdenReport,
  type BurdenScope,
  type CarriedCounters,
  DEFAULT_BURDEN_OPTIONS,
  EMPTY_COUNTERS,
  FAIRNESS_COMPONENTS,
  type FairnessComponent,
  type NurseBurden,
} from './types.js';

/** Every counter that accumulates by summation across the window. `preferenceHitRate` is a
 * 0-1 rate, not a count, and is folded separately as a weighted mean. */
const SUMMED_COUNTERS: readonly (keyof CarriedCounters)[] = [
  'nightShifts',
  'weekendsWorked',
  'holidaysWorked',
  'onCallShifts',
  'undesirableShifts',
  'requestsApproved',
  'requestsDenied',
  'callOutsCovered',
  'totalHours',
  'overtimeHours',
];

function zeroCarried(): CarriedCounters {
  const { periodDays: _days, availableDays: _available, ...carried } = EMPTY_COUNTERS;
  return carried;
}

function emptyDeviation(): Record<FairnessComponent, number> {
  const deviation = {} as Record<FairnessComponent, number>;
  for (const component of FAIRNESS_COMPONENTS) deviation[component] = 0;
  return deviation;
}

function emptyShares(): Record<BurdenComponent, number> {
  const shares = {} as Record<BurdenComponent, number>;
  for (const component of BURDEN_COMPONENTS) shares[component] = 0;
  return shares;
}

/** Days between a row's midpoint and `asOf`: what both the window and the decay measure. */
function ageDays(row: Pick<FairnessLedgerEntry, 'periodStart' | 'periodDays'>, asOf: IsoDate) {
  return dayNumber(asOf) - dayNumber(row.periodStart) - row.periodDays / 2;
}

/** A history row's weight: halves every `halfLifeDays` between its midpoint and `asOf`. */
export function ageWeight(
  row: Pick<FairnessLedgerEntry, 'periodStart' | 'periodDays'>,
  asOf: IsoDate,
  halfLifeDays: number,
): number {
  return 0.5 ** (ageDays(row, asOf) / halfLifeDays);
}

export interface NurseInterim {
  nurseId: Id;
  carried: CarriedCounters;
  shareWeight: number;
  /** Pay periods available, age-weighted. */
  exposure: number;
  /** `shareWeight × exposure`, rounded to hundredths. */
  fairWeight: number;
  periodsInWindow: number;
  /** True once this nurse has at least one row (current or historical) contributing to
   * `carried`, distinct from `fairWeight > 0` — a nurse can have a preference/time-off
   * record without contracted hours to compare burden against. */
  hasContributingRow: boolean;
  /** True when a contributing row had a day available, so her preference rate means something. */
  hasPreferenceRecord: boolean;
}

/** Each nurse's ledger rows inside the window, newest first. */
export type HistoryWindows = ReadonlyMap<Id, readonly FairnessLedgerEntry[]>;

/**
 * Grouping and sorting the ledger was most of the cost of scoring fairness, and the conflicts
 * engine scores the same history once per simulated fix. A history array is never mutated once
 * built (inputs are plain data), so its windows are computed once per array, date and window.
 */
const WINDOWS = new WeakMap<readonly FairnessLedgerEntry[], Map<string, HistoryWindows>>();

/**
 * Each nurse's rows that started before `asOf` and whose midpoint is at most `windowDays` old,
 * newest first (then by period id) so every floating-point sum runs in one fixed order.
 */
export function historyWindows(
  history: readonly FairnessLedgerEntry[],
  asOf: IsoDate,
  windowDays: number,
): HistoryWindows {
  let byKey = WINDOWS.get(history);
  if (!byKey) {
    byKey = new Map();
    WINDOWS.set(history, byKey);
  }
  const key = `${asOf}|${windowDays}`;
  const cached = byKey.get(key);
  if (cached) return cached;

  const byNurse = new Map<Id, FairnessLedgerEntry[]>();
  for (const row of history) {
    // A zero-length row or more days available than the period would divide by nothing or
    // credit a nurse with time that did not exist; both are corrupt data, not a judgement.
    if (
      !(row.periodDays >= 1) ||
      !(row.availableDays >= 0 && row.availableDays <= row.periodDays)
    ) {
      throw new Error(
        `Fairness history row ${row.id} has an invalid period length or available days.`,
      );
    }
    if (compareDates(row.periodStart, asOf) >= 0) continue;
    if (ageDays(row, asOf) > windowDays) continue;
    const rows = byNurse.get(row.nurseId);
    if (rows) rows.push(row);
    else byNurse.set(row.nurseId, [row]);
  }
  const windows = new Map<Id, readonly FairnessLedgerEntry[]>();
  for (const [nurseId, rows] of byNurse) {
    windows.set(
      nurseId,
      rows.sort(
        (a, b) =>
          dayNumber(b.periodStart) - dayNumber(a.periodStart) ||
          a.periodId.localeCompare(b.periodId),
      ),
    );
  }
  byKey.set(key, windows);
  return windows;
}

const NO_ROWS: readonly FairnessLedgerEntry[] = [];

/**
 * Fold one nurse's ledger window (plus the current period, if given) into carried totals,
 * exposure and a fair weight. Kept separate from the team-aggregate pass below so that pass can
 * read every nurse's interim before any deviation is computed — and so the conflicts engine can
 * reuse a nurse's interim when a simulated fix left their counters unchanged.
 */
export function buildInterim(
  nurse: Nurse,
  windows: HistoryWindows,
  options: BurdenOptions,
  scope: BurdenScope,
  current: BurdenCounters | undefined,
): NurseInterim {
  if (current !== undefined && current.periodDays !== scope.periodDays) {
    throw new Error(
      `Counters for nurse ${nurse.id} cover ${current.periodDays} days but the period being ` +
        `scored has ${scope.periodDays}.`,
    );
  }
  const rows = windows.get(nurse.id) ?? NO_ROWS;

  const carried = zeroCarried();
  // Σ w × a over every contributing row: the preference mean's denominator and, over the pay
  // period, the exposure. Weighting the hit rate by days available is what keeps a leave
  // period's vacuous "every preference honoured" from lowering a returner's standing.
  let availableWeight = 0;
  let rateWeightedSum = 0;
  // History only: the per-diem share must not read the assignment being judged.
  let histAvailableWeight = 0;
  let histHours = 0;

  const fold = (counters: BurdenCounters, weight: number) => {
    for (const key of SUMMED_COUNTERS) carried[key] += counters[key] * weight;
    const available = weight * counters.availableDays;
    rateWeightedSum += available * counters.preferenceHitRate;
    availableWeight += available;
  };

  if (current !== undefined) fold(current, 1);
  for (const row of rows) {
    const weight = ageWeight(row, scope.asOf, options.halfLifeDays);
    fold(row, weight);
    histAvailableWeight += weight * row.availableDays;
    histHours += weight * row.totalHours;
  }
  carried.preferenceHitRate = availableWeight > 0 ? rateWeightedSum / availableWeight : 0;

  const exposure = availableWeight / scope.payPeriodDays;
  const shareWeight =
    nurse.contractedHoursPerPeriod > 0
      ? nurse.contractedHoursPerPeriod
      : histAvailableWeight > 0
        ? (scope.payPeriodDays * histHours) / histAvailableWeight
        : 0;

  return {
    nurseId: nurse.id,
    carried,
    shareWeight,
    exposure,
    fairWeight: Math.round(shareWeight * exposure * 100) / 100,
    periodsInWindow: rows.length,
    hasContributingRow: current !== undefined || rows.length > 0,
    hasPreferenceRecord: availableWeight > 0,
  };
}

/** What a nurse with no counters this period carried: nothing, while there all period. */
export function absentCounters(scope: BurdenScope): BurdenCounters {
  return { ...EMPTY_COUNTERS, periodDays: scope.periodDays, availableDays: scope.periodDays };
}

export function computeBurden(
  nurses: readonly Nurse[],
  history: readonly FairnessLedgerEntry[],
  scope: BurdenScope,
  options: Partial<BurdenOptions> = {},
  current?: ReadonlyMap<Id, BurdenCounters>,
): BurdenReport {
  const opts: BurdenOptions = { ...DEFAULT_BURDEN_OPTIONS, ...options };
  const windows = historyWindows(history, scope.asOf, opts.windowDays);
  const interims = nurses.map((nurse) =>
    buildInterim(
      nurse,
      windows,
      opts,
      scope,
      current === undefined ? undefined : (current.get(nurse.id) ?? absentCounters(scope)),
    ),
  );
  const byNurse = burdenByNurse(interims, opts);
  const ranked = [...byNurse.values()].sort(
    (a, b) => b.index - a.index || a.nurseId.localeCompare(b.nurseId),
  );
  return { byNurse, ranked, options: opts };
}

/**
 * Over-share mapped into [0, 1), under-share left as is. Increasing and continuous, so the index
 * still orders nurses the same way per component, but one holiday on a twenty-nurse team (19×
 * over share) no longer outweighs everything else a nurse has carried.
 */
function bounded(deviation: number): number {
  return deviation >= 0 ? deviation / (1 + deviation) : deviation;
}

const IS_BURDEN: ReadonlySet<FairnessComponent> = new Set(BURDEN_COMPONENTS);

/**
 * The team pass: fair shares, deviations and the burden index, from every nurse's interim.
 * Everyone's deviation depends on the team totals, so this always runs over the whole roster.
 */
export function burdenByNurse(
  interims: readonly NurseInterim[],
  opts: BurdenOptions,
): Map<Id, NurseBurden> {
  // Team aggregates for burden components: only nurses with a fair weight can be measured
  // against a fair share, so non-comparable nurses (per-diem with no history, a nurse away all
  // window) drop out of both the numerator and denominator rather than reading as "carries
  // nothing".
  const comparable = interims.filter((i) => i.fairWeight > 0);
  const teamFairWeight = comparable.reduce((sum, i) => sum + i.fairWeight, 0);
  const teamTotals = {} as Record<BurdenComponent, number>;
  for (const component of BURDEN_COMPONENTS) {
    const counterKey = BURDEN_COUNTER[component];
    teamTotals[component] = comparable.reduce((sum, i) => sum + i.carried[counterKey], 0);
  }

  // Preferences: an unweighted mean of nurse rates, so one nurse with lots of ledger rows
  // doesn't drown out one with few — everyone who has an opinion counts equally.
  const withRecord = interims.filter((i) => i.hasPreferenceRecord);
  const teamPreferenceRate =
    withRecord.length > 0
      ? withRecord.reduce((sum, i) => sum + i.carried.preferenceHitRate, 0) / withRecord.length
      : 0;

  // Time off: a pooled rate across the whole roster (not just comparable nurses — a per-diem
  // nurse's approvals still count toward what "the team" typically gets).
  const totalApproved = interims.reduce((sum, i) => sum + i.carried.requestsApproved, 0);
  const totalDecisions = interims.reduce(
    (sum, i) => sum + i.carried.requestsApproved + i.carried.requestsDenied,
    0,
  );
  const teamTimeOffRate = totalDecisions > 0 ? totalApproved / totalDecisions : 1;

  const byNurse = new Map<Id, NurseBurden>();
  for (const interim of interims) {
    const deviation = emptyDeviation();
    const fairShare = emptyShares();
    const isComparable = interim.fairWeight > 0;

    if (isComparable) {
      for (const component of BURDEN_COMPONENTS) {
        const counterKey = BURDEN_COUNTER[component];
        const share = (teamTotals[component] * interim.fairWeight) / teamFairWeight;
        fairShare[component] = share;
        deviation[component] = share > 0 ? (interim.carried[counterKey] - share) / share : 0;
      }
    }

    if (interim.hasPreferenceRecord) {
      deviation.preferences = teamPreferenceRate - interim.carried.preferenceHitRate;
    }

    const decisions = interim.carried.requestsApproved + interim.carried.requestsDenied;
    if (decisions > 0) {
      const nurseRate = interim.carried.requestsApproved / decisions;
      deviation.timeOff = teamTimeOffRate - nurseRate;
    }

    let index = 0;
    for (const component of FAIRNESS_COMPONENTS) {
      const value = deviation[component];
      index += opts.weights[component] * (IS_BURDEN.has(component) ? bounded(value) : value);
    }

    byNurse.set(interim.nurseId, {
      nurseId: interim.nurseId,
      carried: interim.carried,
      shareWeight: interim.shareWeight,
      exposure: interim.exposure,
      fairWeight: interim.fairWeight,
      fairShare,
      comparable: isComparable,
      deviation,
      index,
      periodsInWindow: interim.periodsInWindow,
      hasRows: interim.hasContributingRow,
      hasPreferenceRecord: interim.hasPreferenceRecord,
    });
  }

  return byNurse;
}
