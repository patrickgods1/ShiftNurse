/**
 * Federal in-lieu-of holidays: when a holiday falls on a full-time federal employee's non-workday,
 * a nearby workday becomes her holiday instead (5 U.S.C. § 6103(b); Executive Order 11582; OPM's
 * "In Lieu Of Determination" fact sheet). Sunday holidays move to the next workday, any other to
 * the last workday before (VA Handbook 5011 Part II, Ch. 3, para 3a(1) and 3a(2)). The law gives
 * this to full-time employees only; part-time and intermittent staff have no in-lieu day. The VA
 * also excludes the Baylor plan (VA Handbook 5011 Part II, Ch. 3, para 3a) and nurses on a 72/80
 * schedule who are not scheduled on the holiday (the NOTE under para 3c), so neither gets one.
 *
 * Without it a VA nurse's in-lieu day goes unmarked: holiday pay follows the calendar holiday, so
 * the manager would never be told that the Thursday before a Friday holiday is the nurse's
 * holiday.
 *
 * The published schedule stands in for the basic workweek, which the schedule does not otherwise
 * record. A day on leave or a day nothing is scheduled therefore reads as a non-workday, and a
 * shift on another unit still counts as a day she works.
 */

import { isBaylorPlan } from '../cost/cost.js';
import type { Holiday, Id, Nurse } from '../domain/entities.js';
import { addDays, type IsoDate, weekdayOf } from '../domain/time.js';
import { isWorked } from '../rules/types.js';
import type { AssignmentView } from '../schedule/view.js';

/** How far from the holiday the in-lieu day is looked for; OPM's day is within the same week. */
const SEARCH_DAYS = 6;

/**
 * Each holiday that lands on the nurse's non-workday, mapped to her in-lieu day. Holidays she
 * works, and holidays with no workday within six days in the direction searched, have no entry.
 */
export function inLieuHolidayDates(
  nurse: Pick<Nurse, 'employmentType' | 'scheduleKind'>,
  timeline: readonly AssignmentView[],
  holidays: readonly Holiday[],
): Map<Id, IsoDate> {
  const found = new Map<Id, IsoDate>();
  // Baylor is excluded outright and 72/80 nurses off on the holiday are (5011 above), so for a
  // 72/80 nurse the holiday is never "scheduled" here: she has no in-lieu day to find.
  if (nurse.employmentType !== 'full_time' || isBaylorPlan(nurse)) return found;
  if (nurse.scheduleKind === 'va_72_80') return found;
  const workdays = new Set<IsoDate>();
  for (const view of timeline) if (isWorked(view)) workdays.add(view.assignment.date);

  for (const holiday of holidays) {
    if (workdays.has(holiday.date)) continue;
    const step = weekdayOf(holiday.date) === 0 ? 1 : -1;
    for (let offset = 1; offset <= SEARCH_DAYS; offset++) {
      const candidate = addDays(holiday.date, step * offset);
      if (!workdays.has(candidate)) continue;
      found.set(holiday.id, candidate);
      break;
    }
  }
  return found;
}
