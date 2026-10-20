/**
 * The host's clock changes, read once and handed to core. Pay and the statutory hour caps count
 * hours actually worked (D19: the fall-back night is 13 hours, the spring-forward night 11), but
 * core is pure and may not read the host zone. Without this, a fall-back night would be paid and
 * capped as 12 hours and the nurse's thirteenth hour would vanish from both.
 */

import {
  addDays,
  type DstTransition,
  datesInRange,
  dayNumber,
  type IsoDate,
  type SchedulePeriod,
} from '@shiftnurse/core';

const STEP_MINUTES = 15;
const STEPS_PER_DAY = (24 * 60) / STEP_MINUTES;

/**
 * The host's local clock changes on the dates from `start` to `end` inclusive, on the
 * continuous wall-clock timeline (core's DstTransition). The one place outside today() that
 * constructs a local-time Date on purpose: the DST calendar is a fact about the host's zone,
 * which pay and the statutory hour caps need (D19) and core may not read.
 */
export function hostDstTransitions(start: IsoDate, end: IsoDate): DstTransition[] {
  const out: DstTransition[] = [];
  for (const d of datesInRange(start, end)) {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    const midnight = new Date(y, m - 1, day).getTime();
    // getTimezoneOffset is minutes behind UTC (New York: 300 winter, 240 summer), so spring
    // forward is 300 - 240 = +60 and fall back 240 - 300 = -60.
    for (let k = 1; k <= STEPS_PER_DAY; k++) {
      const before = new Date(midnight + (k - 1) * STEP_MINUTES * 60_000).getTimezoneOffset();
      const after = new Date(midnight + k * STEP_MINUTES * 60_000).getTimezoneOffset();
      if (before !== after) {
        out.push({
          atMinute: dayNumber(d) * 1440 + k * STEP_MINUTES,
          deltaMinutes: before - after,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * A period's clock changes, with its lookback tail (rest and stretch maths reach back into it)
 * and the day after the end, where a night that starts on the last day finishes.
 */
export function dstTransitionsForPeriod(
  period: Pick<SchedulePeriod, 'startDate' | 'endDate'>,
  // Passed in (the caller owns PRIOR_ASSIGNMENT_LOOKBACK_DAYS) so this module imports no repository.
  lookbackDays: number,
): DstTransition[] {
  return hostDstTransitions(
    addDays(period.startDate, -lookbackDays - 1),
    addDays(period.endDate, 1),
  );
}
