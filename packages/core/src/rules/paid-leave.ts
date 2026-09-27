/**
 * Paid leave as hours toward a nurse's contract.
 *
 * A 0.9 FTE nurse who takes a week of PTO has met their commitment for that pay period: payroll
 * pays the leave hours, and a scheduler who reads them as "36 hours short" and adds shifts to
 * make them up is scheduling someone on their vacation's return into overtime. So approved paid
 * leave (PTO, paid sick, bereavement, paid education) and paid sick calls count toward
 * contracted hours. They are not hours *worked*: under federal wage-and-hour law they do not
 * count toward the overtime threshold unless a contract says so, which is the max-hours rule's
 * `paidLeaveCountsTowardOvertime` setting.
 *
 * A request carries the hours it pays (`TimeOffRequest.paidHours`) — the shifts the nurse would
 * have worked, not every calendar day it covers — because leave is approved before the
 * schedule exists and nothing else knows which of those days were workdays. The credit is
 * spread evenly over the request's days, which is what splits a request across two pay
 * periods.
 */

import type { Id, TimeOffRequest, TimeOffType } from '../domain/entities.js';
import { addDays, compareDates, datesInRange, type IsoDate, weekdayOf } from '../domain/time.js';

/** A missed shift paid from sick leave. */
export interface PaidSickCall {
  nurseId: Id;
  date: IsoDate;
  hours: number;
}

/** Paid leave hours credited to one nurse on one date. */
export interface PaidLeaveCredit {
  nurseId: Id;
  date: IsoDate;
  hours: number;
}

/** Leave types that are normally paid, and so default to paid hours. */
export const PAID_LEAVE_TYPES: readonly TimeOffType[] = ['pto', 'sick', 'bereavement', 'education'];

/** Every approved request's paid hours, spread over its days, plus each paid sick call. */
export function paidLeaveCredits(
  timeOff: readonly TimeOffRequest[],
  sickCalls: readonly PaidSickCall[] = [],
): PaidLeaveCredit[] {
  const credits: PaidLeaveCredit[] = [];
  for (const request of timeOff) {
    if (request.status !== 'approved' || !request.paidHours || request.paidHours <= 0) continue;
    const dates = datesInRange(request.startDate, request.endDate);
    const perDay = request.paidHours / dates.length;
    for (const date of dates) credits.push({ nurseId: request.nurseId, date, hours: perDay });
  }
  for (const call of sickCalls) {
    if (call.hours > 0) credits.push({ nurseId: call.nurseId, date: call.date, hours: call.hours });
  }
  return credits;
}

/** Credited hours dated within `[start, end]`. */
export function leaveHoursBetween(
  credits: readonly PaidLeaveCredit[] | undefined,
  start: IsoDate,
  end: IsoDate,
): number {
  let hours = 0;
  for (const c of credits ?? []) {
    if (compareDates(c.date, start) >= 0 && compareDates(c.date, end) <= 0) hours += c.hours;
  }
  return hours;
}

/**
 * Paid leave per nurse per work week, keyed `nurseId|weekStart`: what the cost engine adds
 * to a week's running hours before any shift when a contract counts leave toward overtime.
 */
export function leaveHoursByWorkWeek(
  paidLeaveByNurse: ReadonlyMap<Id, readonly PaidLeaveCredit[]>,
  workWeekStartsOn: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [nurseId, credits] of paidLeaveByNurse) {
    for (const c of credits) {
      const weekStart = addDays(c.date, -((weekdayOf(c.date) - workWeekStartsOn + 7) % 7));
      const key = `${nurseId}|${weekStart}`;
      out.set(key, (out.get(key) ?? 0) + c.hours);
    }
  }
  return out;
}

/**
 * A default for a request's paid hours: the shifts a nurse on this contract works, on average,
 * over that many days, rounded up to whole shifts and never more than one a day. A manager who
 * knows the nurse's actual rota corrects it; the point is not to start from zero or from
 * "every calendar day".
 */
export function suggestedPaidLeaveHours(input: {
  type: TimeOffType;
  days: number;
  contractedHoursPerPeriod: number;
  payPeriodDays: number;
  shiftHours: number;
}): number {
  const { type, days, contractedHoursPerPeriod, payPeriodDays, shiftHours } = input;
  if (!PAID_LEAVE_TYPES.includes(type) || contractedHoursPerPeriod <= 0 || shiftHours <= 0) {
    return 0;
  }
  const shifts = (days * contractedHoursPerPeriod) / (payPeriodDays * shiftHours);
  // Guards against 504 / 168 = 3.0000000001 rounding up to 4.
  return Math.min(days, Math.ceil(shifts - 1e-9)) * shiftHours;
}
