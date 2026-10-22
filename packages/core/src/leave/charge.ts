/**
 * What a nurse's leave balance is debited for a request.
 *
 * 38 U.S.C. § 7456A(b)(3): a 72/80 nurse absent during a scheduled 12-hour tour on "approved sick
 * leave or annual leave" "shall be charged for such leave at a rate of ten hours of leave for every
 * nine hours of absence". Leave is banked in paid hours while the tour is 12 worked hours, so one
 * tour off costs 13⅓ hours of balance. The statute names only sick and annual leave, so comp time
 * and PTO are charged hour for hour. A request's `paidHours` stays the hours worked it covers
 * (contracted hours here are hours worked, and that is what counts toward the 72); only the debit
 * grows, here, where a balance is charged. Applying 10/9 at both ends would charge twice.
 */

import type { LeaveBalanceType, ScheduleKind } from '../domain/entities.js';

export function leaveChargeHours(
  scheduleKind: ScheduleKind | undefined,
  type: LeaveBalanceType,
  hours: number,
): number {
  return scheduleKind === 'va_72_80' && (type === 'annual' || type === 'sick')
    ? (hours * 10) / 9
    : hours;
}
