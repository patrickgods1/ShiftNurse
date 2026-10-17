/**
 * How far back a period's published history is complete.
 *
 * A pay period is judged by the schedule that holds its end, its earlier days read from the
 * lookback tail. That only works when the tail is whole: a gap (a period still a draft, or never
 * made) looks exactly like days off, and a nurse would read as short of their contract for hours
 * nobody has scheduled yet. This answers the one question the rules need — from which date is the
 * tail known to be complete — so a shortfall is judged only over days that are on record.
 */

import type { SchedulePeriod } from '../domain/entities.js';
import { addDays, compareDates, dateInRange, type IsoDate, maxDate } from '../domain/time.js';

/**
 * The first date from which a period's lookback tail is complete: every day from it to the day
 * before `periodStart` lies in a published schedule of the unit, and it is no earlier than the
 * tail reaches. `periodStart` itself when the day before is in no published schedule.
 */
export function historyCompleteFrom(
  published: readonly Pick<SchedulePeriod, 'startDate' | 'endDate'>[],
  periodStart: IsoDate,
  lookbackDays: number,
): IsoDate {
  const floor = addDays(periodStart, -lookbackDays);
  let from = periodStart;
  // Each step moves `from` strictly earlier or onto the floor, so the walk ends.
  for (;;) {
    const prev = addDays(from, -1);
    if (compareDates(prev, floor) < 0) return from;
    const holder = published.find((p) => dateInRange(prev, p.startDate, p.endDate));
    if (!holder) return from;
    from = maxDate(holder.startDate, floor);
  }
}
