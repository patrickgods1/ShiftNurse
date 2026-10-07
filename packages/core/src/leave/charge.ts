/**
 * What a nurse's leave balance is debited for a request.
 *
 * 38 U.S.C. § 7456A(d): a 72/80 nurse "shall be charged 10 hours of leave for each 9 hours of
 * absence". Leave is banked in paid hours while the tour is 12 worked hours, so one tour off costs
 * 13⅓ hours of balance. A request's `paidHours` stays the hours worked it covers (contracted hours
 * here are hours worked, and that is what counts toward the 72); only the debit grows, here, where
 * a balance or an FMLA entitlement is charged. Applying 10/9 at both ends would charge twice.
 */

import type { ScheduleKind } from '../domain/entities.js';

export function leaveChargeHours(scheduleKind: ScheduleKind | undefined, hours: number): number {
  return scheduleKind === 'va_72_80' ? (hours * 10) / 9 : hours;
}
