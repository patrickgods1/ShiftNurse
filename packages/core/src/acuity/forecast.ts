/**
 * Census forecasting from history, and the back-test that keeps it honest.
 *
 * The forecaster is deliberately simple: a same-weekday, same-shift moving average with an
 * optional seasonal index from the same time last year. A unit manager can explain that
 * model to a finance director in one sentence, and "why did it say 24?" is answerable from
 * the `basis` on every proposal. A cleverer model that cannot be explained would not be
 * trusted, and a forecast that is not trusted gets overridden by hand, which is where we
 * started. Proposals are exactly that — the manager confirms or edits every number.
 *
 * The back-test exists because forecasts drift. It scores both what was *recorded* (the
 * manager's final numbers versus actuals) and what the *model* would have said using only
 * the history available at the time, so the two can be compared: if the model beats the
 * recorded forecasts, the manager is over-editing; if it loses, the model needs work.
 *
 * Pure data-in, data-out; no clock reads. The caller decides what "today" is.
 */

import type { CensusForecast, Id } from '../domain/entities.js';
import { addDays, dayNumber, type IsoDate, weekdayOf } from '../domain/time.js';

export interface ForecastOptions {
  /** Weeks of same-weekday history to average. Default 8. */
  lookbackWeeks?: number;
  /** Apply the seasonal index from the same weeks last year. Default true. */
  seasonal?: boolean;
  /** Half-width of the "same time last year" window, in weeks. Default 2. */
  seasonalWindowWeeks?: number;
}

export interface ForecastTarget {
  date: IsoDate;
  shiftTypeId: Id;
}

export interface ProposalBasis {
  /** Same-weekday rows that fed the average. */
  samples: number;
  weekdayAverage: number;
  /** 1 when seasonality is off or last year has no data. */
  seasonalIndex: number;
  seasonalSamples: number;
}

export interface CensusProposal extends ForecastTarget {
  projectedCensus: number;
  /** Sums to `projectedCensus`; proportions follow the sampled history. */
  acuityMix: Record<Id, number>;
  basis: ProposalBasis;
}

interface Observation {
  date: IsoDate;
  day: number;
  weekday: number;
  shiftTypeId: Id;
  census: number;
  mix: Record<Id, number>;
}

/** The number that actually happened when known; the projection is the next best evidence. */
function observe(f: CensusForecast): Observation {
  return {
    date: f.date,
    day: dayNumber(f.date),
    weekday: weekdayOf(f.date),
    shiftTypeId: f.shiftTypeId,
    census: f.actualCensus ?? f.projectedCensus,
    mix: f.actualAcuityMix ?? f.acuityMix,
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Split `total` across tiers in proportion to `weights`, as whole patients that sum exactly
 * to `total` (largest-remainder rounding). A mix that does not add up fails validation, so
 * the forecaster must never produce one.
 */
export function apportionMix(total: number, weights: Record<Id, number>): Record<Id, number> {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const weightSum = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0 || entries.length === 0 || weightSum <= 0) return {};

  const exact = entries.map(([id, w]) => ({ id, exact: (total * w) / weightSum }));
  const result: Record<Id, number> = {};
  let assigned = 0;
  for (const e of exact) {
    result[e.id] = Math.floor(e.exact);
    assigned += result[e.id]!;
  }
  const byRemainder = [...exact].sort(
    (a, b) =>
      b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.id.localeCompare(b.id),
  );
  for (let i = 0; assigned < total; i++) {
    const e = byRemainder[i % byRemainder.length]!;
    result[e.id] = (result[e.id] ?? 0) + 1;
    assigned++;
  }
  return result;
}

/** Propose a census and acuity mix for each target that has usable history. */
export function proposeCensus(
  history: readonly CensusForecast[],
  targets: readonly ForecastTarget[],
  options: ForecastOptions = {},
): CensusProposal[] {
  const lookbackWeeks = options.lookbackWeeks ?? 8;
  const seasonal = options.seasonal ?? true;
  const windowDays = (options.seasonalWindowWeeks ?? 2) * 7;

  const observations = history.map(observe);
  const proposals: CensusProposal[] = [];

  for (const target of targets) {
    const targetDay = dayNumber(target.date);
    const weekday = weekdayOf(target.date);
    const earliest = targetDay - lookbackWeeks * 7;

    const recent = observations.filter(
      (o) =>
        o.shiftTypeId === target.shiftTypeId &&
        o.weekday === weekday &&
        o.day < targetDay &&
        o.day >= earliest,
    );
    if (recent.length === 0) continue;

    const weekdayAverage = mean(recent.map((o) => o.census));

    let seasonalIndex = 1;
    let seasonalSamples = 0;
    if (seasonal) {
      const anniversary = dayNumber(addDays(target.date, -364));
      const lastYear = observations.filter(
        (o) =>
          o.shiftTypeId === target.shiftTypeId &&
          o.weekday === weekday &&
          Math.abs(o.day - anniversary) <= 26 * 7,
      );
      const near = lastYear.filter((o) => Math.abs(o.day - anniversary) <= windowDays);
      const annual = mean(lastYear.map((o) => o.census));
      if (near.length > 0 && lastYear.length > near.length && annual > 0) {
        seasonalIndex = mean(near.map((o) => o.census)) / annual;
        seasonalSamples = near.length;
      }
    }

    const projectedCensus = Math.round(weekdayAverage * seasonalIndex);

    const weights: Record<Id, number> = {};
    for (const o of recent) {
      for (const [tierId, n] of Object.entries(o.mix)) weights[tierId] = (weights[tierId] ?? 0) + n;
    }

    proposals.push({
      date: target.date,
      shiftTypeId: target.shiftTypeId,
      projectedCensus,
      acuityMix: apportionMix(projectedCensus, weights),
      basis: { samples: recent.length, weekdayAverage, seasonalIndex, seasonalSamples },
    });
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Problems with a census entry, in words a manager can act on. Empty means valid. */
export function validateAcuityMix(
  projectedCensus: number,
  acuityMix: Record<Id, number>,
): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(projectedCensus) || projectedCensus < 0) {
    problems.push(`Census ${projectedCensus} must be a whole number of patients`);
  }
  let sum = 0;
  for (const [tierId, n] of Object.entries(acuityMix)) {
    if (!Number.isInteger(n) || n < 0) {
      problems.push(`Tier ${tierId} count ${n} must be a whole, non-negative number`);
      continue;
    }
    sum += n;
  }
  if (problems.length === 0 && sum !== projectedCensus) {
    problems.push(`Acuity mix adds up to ${sum} patients but the census is ${projectedCensus}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Back-test
// ---------------------------------------------------------------------------

export interface ErrorSummary {
  samples: number;
  /** Mean |forecast − actual|, in patients. */
  meanAbsoluteError: number;
  /** Mean |forecast − actual| / actual × 100, over rows with a non-zero actual. */
  meanAbsolutePercentageError: number;
  /** Mean (forecast − actual): positive means forecasts run high. */
  bias: number;
}

export interface BacktestResult {
  /** The recorded projections versus what happened. */
  recorded: ErrorSummary;
  /** What the model would have proposed from prior history versus what happened. */
  model: ErrorSummary;
  byShiftType: Record<Id, { recorded: ErrorSummary; model: ErrorSummary }>;
}

function summarize(errors: readonly { forecast: number; actual: number }[]): ErrorSummary {
  if (errors.length === 0) {
    return { samples: 0, meanAbsoluteError: 0, meanAbsolutePercentageError: 0, bias: 0 };
  }
  const signed = errors.map((e) => e.forecast - e.actual);
  const pct = errors
    .filter((e) => e.actual !== 0)
    .map((e) => (Math.abs(e.forecast - e.actual) / e.actual) * 100);
  return {
    samples: errors.length,
    meanAbsoluteError: mean(signed.map(Math.abs)),
    meanAbsolutePercentageError: pct.length ? mean(pct) : 0,
    bias: mean(signed),
  };
}

export function backtest(
  forecasts: readonly CensusForecast[],
  options: ForecastOptions = {},
): BacktestResult {
  const sorted = [...forecasts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const recorded: { shiftTypeId: Id; forecast: number; actual: number }[] = [];
  const model: { shiftTypeId: Id; forecast: number; actual: number }[] = [];

  for (const row of sorted) {
    if (row.actualCensus === undefined) continue;
    recorded.push({
      shiftTypeId: row.shiftTypeId,
      forecast: row.projectedCensus,
      actual: row.actualCensus,
    });

    const prior = sorted.filter((h) => h.date < row.date);
    const [proposal] = proposeCensus(
      prior,
      [{ date: row.date, shiftTypeId: row.shiftTypeId }],
      options,
    );
    if (proposal) {
      model.push({
        shiftTypeId: row.shiftTypeId,
        forecast: proposal.projectedCensus,
        actual: row.actualCensus,
      });
    }
  }

  const shiftTypeIds = new Set([...recorded, ...model].map((e) => e.shiftTypeId));
  const byShiftType: BacktestResult['byShiftType'] = {};
  for (const id of shiftTypeIds) {
    byShiftType[id] = {
      recorded: summarize(recorded.filter((e) => e.shiftTypeId === id)),
      model: summarize(model.filter((e) => e.shiftTypeId === id)),
    };
  }
  return { recorded: summarize(recorded), model: summarize(model), byShiftType };
}
