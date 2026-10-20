/**
 * Availability — how many days of a period a nurse was actually there to carry its burdens.
 *
 * Fairness compares what a nurse carried per day she was available (D15). Without this, a nurse
 * on FMLA for most of a period reads as "carried nothing while here" and is pushed onto the next
 * schedule's nights to catch up, which is exactly the retaliation for protected leave that
 * 29 CFR 825.220(c) forbids; a new hire's half period reads the same way.
 *
 * ## Why days, not hours
 *
 * D15 speaks of "contract minus approved leave", but a leave request's hours are not a reliable
 * measure of absence: unpaid FMLA carries `paidHours` 0, so an hours measure would show a nurse on
 * twelve weeks of unpaid leave as fully available — the defect this exists to fix. A request's
 * dates are always known, so availability is counted in calendar days.
 *
 * Every approved type counts, not only protected leave: a nurse on two weeks' vacation was not
 * there to carry nights either, and the model is neutral for every kind.
 *
 * Kept apart from `ledger.ts` so the burden model and the solver can read it without the ledger's
 * schedule walk.
 */

import type { Nurse, TimeOffRequest } from '../domain/entities.js';
import { compareDates, dateInRange, datesInRange, type IsoDate } from '../domain/time.js';

/**
 * Days of `start`..`end` (inclusive) on or after the nurse's `hireDate` and inside none of her
 * approved time-off requests. A day covered by two overlapping requests is taken out once.
 */
export function daysAvailable(
  nurse: Pick<Nurse, 'id' | 'hireDate'>,
  start: IsoDate,
  end: IsoDate,
  timeOff: readonly Pick<TimeOffRequest, 'nurseId' | 'startDate' | 'endDate' | 'status'>[],
): number {
  const leave = timeOff.filter((r) => r.nurseId === nurse.id && r.status === 'approved');
  const hireDate = nurse.hireDate;
  let available = 0;
  for (const date of datesInRange(start, end)) {
    if (hireDate !== undefined && compareDates(date, hireDate) < 0) continue;
    if (leave.some((r) => dateInRange(date, r.startDate, r.endDate))) continue;
    available++;
  }
  return available;
}
