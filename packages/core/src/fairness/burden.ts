/**
 * Burden — how much of the team's undesirable-shift load each nurse has carried, across a
 * decayed ledger history plus (optionally) the period being scored right now.
 *
 * This is the one place that turns raw counters into a *fair share*, so `score.ts` (the
 * per-nurse breakdown) and anything the solver later reads for "who is owed relief" agree by
 * construction instead of re-deriving the same proportional split twice and drifting apart.
 * See `types.ts` for why fair share is pinned to `contractedHoursPerPeriod` rather than hours
 * actually worked — this module never reads worked hours to decide who "should" carry more.
 */

import type { FairnessLedgerEntry, Id, Nurse } from '../domain/entities.js';
import { dayNumber } from '../domain/time.js';
import {
  BURDEN_COMPONENTS,
  BURDEN_COUNTER,
  type BurdenComponent,
  type BurdenCounters,
  type BurdenOptions,
  type BurdenReport,
  DEFAULT_BURDEN_OPTIONS,
  EMPTY_COUNTERS,
  FAIRNESS_COMPONENTS,
  type FairnessComponent,
  type NurseBurden,
} from './types.js';

/** Every counter that accumulates by summation across the window. `preferenceHitRate` is a
 * 0-1 rate, not a count, and is folded separately as a weighted mean (see `foldCounters`). */
const SUMMED_COUNTERS: readonly (keyof BurdenCounters)[] = [
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

function zeroCounters(): BurdenCounters {
  return { ...EMPTY_COUNTERS };
}

function emptyDeviation(): Record<FairnessComponent, number> {
  const deviation = {} as Record<FairnessComponent, number>;
  for (const component of FAIRNESS_COMPONENTS) deviation[component] = 0;
  return deviation;
}

interface WeightedRow {
  counters: BurdenCounters;
  weight: number;
}

/**
 * Fold decay-weighted rows into one carried total. Summing `preferenceHitRate` would let a
 * nurse with ten stale ledger rows out-rank one with two on a rate that is supposed to top
 * out at 1 — it has to be a weighted mean instead.
 */
function foldCounters(rows: readonly WeightedRow[]): BurdenCounters {
  const carried = zeroCounters();
  let rateWeightTotal = 0;
  let rateWeightedSum = 0;
  for (const { counters, weight } of rows) {
    for (const key of SUMMED_COUNTERS) {
      carried[key] += counters[key] * weight;
    }
    rateWeightedSum += counters.preferenceHitRate * weight;
    rateWeightTotal += weight;
  }
  carried.preferenceHitRate = rateWeightTotal > 0 ? rateWeightedSum / rateWeightTotal : 0;
  return carried;
}

export interface NurseInterim {
  nurseId: Id;
  carried: BurdenCounters;
  shareWeight: number;
  periodsInWindow: number;
  /** True once this nurse has at least one row (current or historical) contributing to
   * `carried`, distinct from `shareWeight > 0` — a nurse can have a preference/time-off
   * record without contracted hours to compare burden against. */
  hasContributingRow: boolean;
}

/** Each nurse's ledger rows inside the window, newest first. */
export type HistoryWindows = ReadonlyMap<Id, readonly FairnessLedgerEntry[]>;

/**
 * Grouping and sorting the ledger was most of the cost of scoring fairness, and the conflicts
 * engine scores the same history once per simulated fix. A history array is never mutated once
 * built (inputs are plain data), so its windows are computed once per array and window size.
 */
const WINDOWS = new WeakMap<readonly FairnessLedgerEntry[], Map<number, HistoryWindows>>();

export function historyWindows(
  history: readonly FairnessLedgerEntry[],
  windowPeriods: number,
): HistoryWindows {
  let bySize = WINDOWS.get(history);
  if (!bySize) {
    bySize = new Map();
    WINDOWS.set(history, bySize);
  }
  const cached = bySize.get(windowPeriods);
  if (cached) return cached;

  const byNurse = new Map<Id, FairnessLedgerEntry[]>();
  for (const row of history) {
    const rows = byNurse.get(row.nurseId);
    if (rows) rows.push(row);
    else byNurse.set(row.nurseId, [row]);
  }
  const windows = new Map<Id, readonly FairnessLedgerEntry[]>();
  for (const [nurseId, rows] of byNurse) {
    windows.set(
      nurseId,
      rows
        .slice()
        .sort(
          (a, b) =>
            dayNumber(b.periodStart) - dayNumber(a.periodStart) ||
            a.periodId.localeCompare(b.periodId),
        )
        .slice(0, windowPeriods),
    );
  }
  bySize.set(windowPeriods, windows);
  return windows;
}

const NO_ROWS: readonly FairnessLedgerEntry[] = [];

/**
 * Fold one nurse's ledger window (plus the current period, if given) into carried totals and
 * a fair-share basis. Kept separate from the team-aggregate pass below so that pass can read
 * every nurse's `carried`/`shareWeight` before any deviation is computed — and so the conflicts
 * engine can reuse a nurse's interim when a simulated fix left their counters unchanged.
 */
export function buildInterim(
  nurse: Nurse,
  windows: HistoryWindows,
  options: BurdenOptions,
  current: BurdenCounters | undefined,
): NurseInterim {
  const rows = windows.get(nurse.id) ?? NO_ROWS;

  const hasCurrent = current !== undefined;
  const weightedRows: WeightedRow[] = [];
  if (hasCurrent) {
    weightedRows.push({ counters: current, weight: 1 });
  }
  // k = 0 is the most recent historical row. With a current row present it decays starting
  // one step back (decay^(k+1)); without one, the most recent historical row itself carries
  // full weight (decay^k, so decay^0 = 1).
  rows.forEach((row, k) => {
    const weight = hasCurrent ? options.decay ** (k + 1) : options.decay ** k;
    weightedRows.push({ counters: row, weight });
  });

  const carried = foldCounters(weightedRows);

  const shareWeight =
    nurse.contractedHoursPerPeriod > 0
      ? nurse.contractedHoursPerPeriod
      : rows.length > 0
        ? rows.reduce((sum, row) => sum + row.totalHours, 0) / rows.length
        : 0;

  return {
    nurseId: nurse.id,
    carried,
    shareWeight,
    periodsInWindow: rows.length,
    hasContributingRow: hasCurrent || rows.length > 0,
  };
}

export function computeBurden(
  nurses: readonly Nurse[],
  history: readonly FairnessLedgerEntry[],
  options: Partial<BurdenOptions> = {},
  current?: ReadonlyMap<Id, BurdenCounters>,
): BurdenReport {
  const opts: BurdenOptions = { ...DEFAULT_BURDEN_OPTIONS, ...options };
  const windows = historyWindows(history, opts.windowPeriods);
  const interims = nurses.map((nurse) =>
    buildInterim(
      nurse,
      windows,
      opts,
      current === undefined ? undefined : (current.get(nurse.id) ?? zeroCounters()),
    ),
  );
  const byNurse = burdenByNurse(interims, opts);
  const ranked = [...byNurse.values()].sort(
    (a, b) => b.index - a.index || a.nurseId.localeCompare(b.nurseId),
  );
  return { byNurse, ranked, options: opts };
}

/**
 * The team pass: fair shares, deviations and the burden index, from every nurse's interim.
 * Everyone's deviation depends on the team totals, so this always runs over the whole roster.
 */
export function burdenByNurse(
  interims: readonly NurseInterim[],
  opts: BurdenOptions,
): Map<Id, NurseBurden> {
  // Team aggregates for burden components: only nurses with a share weight can be measured
  // against a fair share, so non-comparable nurses (per-diem with no history) drop out of
  // both the numerator and denominator rather than silently reading as "carries nothing".
  const comparable = interims.filter((i) => i.shareWeight > 0);
  const teamShare = comparable.reduce((sum, i) => sum + i.shareWeight, 0);
  const teamTotals = {} as Record<BurdenComponent, number>;
  for (const component of BURDEN_COMPONENTS) {
    const counterKey = BURDEN_COUNTER[component];
    teamTotals[component] = comparable.reduce((sum, i) => sum + i.carried[counterKey], 0);
  }

  // Preferences: an unweighted mean of nurse rates, so one nurse with lots of ledger rows
  // doesn't drown out one with few — everyone who has an opinion counts equally.
  const withRows = interims.filter((i) => i.hasContributingRow);
  const teamPreferenceRate =
    withRows.length > 0
      ? withRows.reduce((sum, i) => sum + i.carried.preferenceHitRate, 0) / withRows.length
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

    if (interim.shareWeight > 0) {
      for (const component of BURDEN_COMPONENTS) {
        const counterKey = BURDEN_COUNTER[component];
        const fairShare = (teamTotals[component] * interim.shareWeight) / teamShare;
        deviation[component] =
          fairShare > 0 ? (interim.carried[counterKey] - fairShare) / fairShare : 0;
      }
    }

    if (interim.hasContributingRow) {
      deviation.preferences = teamPreferenceRate - interim.carried.preferenceHitRate;
    }

    const decisions = interim.carried.requestsApproved + interim.carried.requestsDenied;
    if (decisions > 0) {
      const nurseRate = interim.carried.requestsApproved / decisions;
      deviation.timeOff = teamTimeOffRate - nurseRate;
    }

    let index = 0;
    for (const component of FAIRNESS_COMPONENTS) {
      index += opts.weights[component] * deviation[component];
    }

    byNurse.set(interim.nurseId, {
      nurseId: interim.nurseId,
      carried: interim.carried,
      shareWeight: interim.shareWeight,
      deviation,
      index,
      periodsInWindow: interim.periodsInWindow,
      hasRows: interim.hasContributingRow,
    });
  }

  return byNurse;
}

/**
 * Recompute one nurse's fair share for a burden component from an already-built report. It
 * has to reproduce `computeBurden`'s internal formula exactly (team total proportional to
 * share weight) rather than approximate it, since `score.ts` shows this number right next to
 * "carried" in the breakdown UI — if the two ever disagreed the explanation would be visibly
 * self-contradictory.
 */
export function burdenFairShare(
  byNurse: ReadonlyMap<Id, NurseBurden>,
  nurseId: Id,
  component: BurdenComponent,
): number {
  const nurse = byNurse.get(nurseId);
  if (!nurse || nurse.shareWeight <= 0) return 0;

  const counterKey = BURDEN_COUNTER[component];
  let teamTotal = 0;
  let teamShare = 0;
  for (const other of byNurse.values()) {
    if (other.shareWeight > 0) {
      teamTotal += other.carried[counterKey];
      teamShare += other.shareWeight;
    }
  }
  return teamShare > 0 ? (teamTotal * nurse.shareWeight) / teamShare : 0;
}
