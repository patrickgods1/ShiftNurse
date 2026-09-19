/**
 * Pay-rate resolution — which hourly rate a nurse is on for a given date.
 *
 * Rates are declared *as of* a date and stay in force until superseded, the way a raise letter
 * reads ("effective 10 January your rate is $50/h"). Two consequences that the naive "newest
 * row wins" gets wrong: a rate dated in the future must be ignored until it starts, and a
 * schedule that straddles a raise must price the shifts before the raise at the old rate.
 *
 * This lives in core rather than only in the database layer because the solver and the
 * candidate-pricing path need it on in-memory data; the repository's lookup delegates here so
 * there is exactly one definition of "the rate in force".
 */

import type { Nurse, PayRate } from '../domain/entities.js';
import { compareDates, type IsoDate } from '../domain/time.js';
import type { RateSource } from './types.js';

export interface ResolvedRate {
  rate: PayRate;
  source: Exclude<RateSource, 'none'>;
}

/** The latest rate whose `effectiveFrom` is on or before `date`, or nothing if none has started. */
export function latestRateInForce(rates: readonly PayRate[], date: IsoDate): PayRate | undefined {
  let best: PayRate | undefined;
  for (const rate of rates) {
    if (compareDates(rate.effectiveFrom, date) > 0) continue;
    if (!best || compareDates(rate.effectiveFrom, best.effectiveFrom) > 0) best = rate;
  }
  return best;
}

/**
 * The rate in force for a nurse on a date. A per-nurse rate always beats the role default —
 * an individually negotiated rate is never overridden by a blanket one — but only once it has
 * started; before that the role default still applies.
 */
export function resolvePayRate(
  rates: readonly PayRate[],
  nurse: Pick<Nurse, 'id' | 'role'>,
  date: IsoDate,
): ResolvedRate | undefined {
  const own = latestRateInForce(
    rates.filter((r) => r.nurseId === nurse.id),
    date,
  );
  if (own) return { rate: own, source: 'nurse' };

  const roleDefault = latestRateInForce(
    rates.filter((r) => r.nurseId === null && r.role === nurse.role),
    date,
  );
  if (roleDefault) return { rate: roleDefault, source: 'role' };

  return undefined;
}
