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
 * schedule exists and nothing else knows which of those days were workdays. The credit is cut
 * into whole shifts of the unit's lengths and the shifts are spaced evenly over the request's
 * days, which is what splits a request across two pay periods.
 *
 * Whole shifts, because payroll charges leave a shift at a time and because a credit has to be
 * something the nurse's own shifts can top up to the contract. Spread by the day, a week off
 * paid at 36 hours that began on a pay period's last Saturday put 5.1h in that period and 30.9h
 * in the next: targets of 66.9h and 41.1h, which no run of 12-hour shifts can meet, so an
 * approved, paid week off left the nurse "short" in both.
 */

import type { Id, TimeOffRequest, TimeOffType } from '../domain/entities.js';
import { compareDates, datesInRange, type IsoDate } from '../domain/time.js';

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

const EPSILON = 1e-9;

/**
 * `hours` as whole shifts, longest first, with what is left (less than the shortest shift) as one
 * last part shift: 36 of 12s is three 12s; 20 of 12s and 8s is a 12 and an 8.
 */
function asShifts(hours: number, shiftHours: readonly number[]): number[] {
  const lengths = [...new Set(shiftHours.filter((h) => h > 0))].sort((a, b) => b - a);
  const shifts: number[] = [];
  let left = hours;
  while (left > EPSILON) {
    const fits = lengths.find((h) => h <= left + EPSILON);
    if (fits === undefined) {
      shifts.push(left);
      break;
    }
    shifts.push(fits);
    left -= fits;
  }
  return shifts;
}

/**
 * Every approved request's paid hours as whole shifts over its days, plus each paid sick call.
 * `shiftHours` are the unit's shift lengths; with none, a request is one credit mid-request.
 */
export function paidLeaveCredits(
  timeOff: readonly TimeOffRequest[],
  sickCalls: readonly PaidSickCall[] = [],
  shiftHours: readonly number[] = [],
): PaidLeaveCredit[] {
  const credits: PaidLeaveCredit[] = [];
  for (const request of timeOff) {
    if (request.status !== 'approved' || !request.paidHours || request.paidHours <= 0) continue;
    const dates = datesInRange(request.startDate, request.endDate);
    const shifts = asShifts(request.paidHours, shiftHours);
    // Shift i sits at the middle of its share of the days: three shifts over seven days land on
    // the 2nd, 4th and 6th, never bunched at either end of the request.
    shifts.forEach((hours, i) => {
      const day = Math.min(
        dates.length - 1,
        Math.floor(((i + 0.5) * dates.length) / shifts.length),
      );
      credits.push({ nurseId: request.nurseId, date: dates[day]!, hours });
    });
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
 * A default for a request's paid hours: the shifts a nurse on this contract works, on average,
 * over that many days, rounded up to whole shifts and never more than one a day. A manager who
 * knows the nurse's actual rota corrects it; the point is not to start from zero or from
 * "every calendar day".
 */
/**
 * The shift length a day of paid leave is worth when the manager has not said otherwise: what
 * most of the unit's worked shift types run (the longer on a tie). A 12-hour unit's PTO day is 12
 * hours, a VA tour 8. One definition for the request dialog and for leave awarded by bidding.
 */
export function typicalShiftHours(
  shiftTypes: readonly { durationHours: number; active: boolean; isOnCall: boolean }[],
): number {
  const counts = new Map<number, number>();
  for (const s of shiftTypes) {
    if (!s.active || s.isOnCall) continue;
    counts.set(s.durationHours, (counts.get(s.durationHours) ?? 0) + 1);
  }
  let best: [number, number] | undefined;
  for (const [hours, n] of counts) {
    if (!best || n > best[1] || (n === best[1] && hours > best[0])) best = [hours, n];
  }
  return best?.[0] ?? 8;
}

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
