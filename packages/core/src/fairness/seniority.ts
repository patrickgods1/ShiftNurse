/**
 * Seniority — a multiplier on preference weight, never a rule of its own.
 *
 * Why this module exists: many union contracts give senior staff first pick of shifts and
 * schedules, but that has to enter the objective as a *weight*, not as a hard override —
 * otherwise a senior nurse's preference could bump a junior nurse off a shift the solver
 * needed them on, silently turning a soft preference into an illegal assignment. Scaling
 * `Preference.weight` by rank keeps seniority advisory: it changes which unmet preference
 * the solver would rather absorb, never which hard rule holds.
 */

import type { Id, Nurse, Preference } from '../domain/entities.js';
import { dayNumber } from '../domain/time.js';
import { DEFAULT_SENIORITY, type SeniorityOptions } from './types.js';

/**
 * nurseId -> multiplier in [1, 1 + boost]. Rank is over *distinct seniority dates* among the
 * nurses passed in, not over nurses themselves, so two nurses hired the same day share a rank
 * (and a multiplier) rather than one arbitrarily outranking the other by array position.
 */
export function seniorityMultipliers(
  nurses: readonly Nurse[],
  options: SeniorityOptions = DEFAULT_SENIORITY,
): Map<Id, number> {
  const result = new Map<Id, number>();
  const { boost } = options;

  // Distinct dates, earliest (most senior) first. Sorting the dates rather than the nurses is
  // what makes ties a property of the date, not of iteration order.
  const distinctDates = [...new Set(nurses.map((n) => n.seniorityDate))].sort(
    (a, b) => dayNumber(a) - dayNumber(b),
  );
  const rankCount = distinctDates.length;

  const rankByDate = new Map<string, number>();
  distinctDates.forEach((date, rank) => {
    rankByDate.set(date, rank);
  });

  for (const nurse of nurses) {
    // A single seniority date in play (one nurse, or everyone hired the same day) has no
    // spread to rank over, so nobody is more or less senior than anyone else.
    if (rankCount <= 1) {
      result.set(nurse.id, 1);
      continue;
    }
    const rank = rankByDate.get(nurse.seniorityDate) ?? rankCount - 1;
    // rank 0 (most senior) -> 1 + boost; rank (rankCount - 1) (least senior) -> 1; linear between.
    const multiplier = 1 + boost * (1 - rank / (rankCount - 1));
    result.set(nurse.id, multiplier);
  }

  return result;
}

/** Convenience for a single nurse — recomputes the whole roster's multipliers, so prefer
 * `seniorityMultipliers` when scoring more than one nurse. */
export function seniorityMultiplier(
  nurse: Nurse,
  nurses: readonly Nurse[],
  options: SeniorityOptions = DEFAULT_SENIORITY,
): number {
  return seniorityMultipliers(nurses, options).get(nurse.id) ?? 1;
}

/** `pref.weight` scaled by seniority — what the solver's objective charges for leaving this
 * preference unmet. */
export function preferenceWeight(
  pref: Preference,
  nurse: Nurse,
  nurses: readonly Nurse[],
  options: SeniorityOptions = DEFAULT_SENIORITY,
): number {
  return pref.weight * seniorityMultiplier(nurse, nurses, options);
}
