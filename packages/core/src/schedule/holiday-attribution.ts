/**
 * Which holiday a shift works — the one definition (D18).
 *
 * A night that runs from Christmas Eve into Christmas morning works seven of its twelve hours on
 * Christmas. The fairness convention dates it by its start, so it is not a holiday shift; many
 * contracts instead pay holiday premium for the hours worked on the holiday, or give the whole
 * shift to the day most of it falls on. If pay, the fairness ledger, the holiday rotation, the
 * per-diem commitment and the solvers each decided this for themselves, a nurse could be paid for
 * a holiday the rotation says she never worked. So every one of them asks here, with the unit's
 * `holidayAttribution`.
 */

import type { HolidayAttribution } from '../domain/entities.js';
import {
  fromDayNumber,
  type IsoDate,
  MINUTES_PER_DAY,
  type ShiftTiming,
  type ShiftWindow,
  shiftWindow,
} from '../domain/time.js';
import { type DstTransition, realMinutesIn } from './real-minutes.js';

export type { HolidayAttribution };

/** Wall minutes of the window on each calendar day it touches, in day order. */
function minutesByDay(window: ShiftWindow): { day: number; minutes: number }[] {
  const out: { day: number; minutes: number }[] = [];
  const first = Math.floor(window.startMinute / MINUTES_PER_DAY);
  for (let day = first; day * MINUTES_PER_DAY < window.endMinute; day++) {
    const from = Math.max(window.startMinute, day * MINUTES_PER_DAY);
    const to = Math.min(window.endMinute, (day + 1) * MINUTES_PER_DAY);
    if (to > from) out.push({ day, minutes: to - from });
  }
  return out;
}

/**
 * The holiday dates a shift works, by the unit's attribution. Judged on the *scheduled*
 * window (shiftWindow(date, shiftType)), so a holdover never changes who worked a holiday.
 * At most two dates (a shift is under 24 hours).
 */
export function attributedHolidayDates(
  date: IsoDate,
  timing: ShiftTiming,
  attribution: HolidayAttribution,
  isHoliday: (d: IsoDate) => boolean,
): IsoDate[] {
  if (attribution === 'start') return isHoliday(date) ? [date] : [];
  const days = minutesByDay(shiftWindow(date, timing));
  if (attribution === 'clock')
    return days.map((d) => fromDayNumber(d.day)).filter((d) => isHoliday(d));
  // Majority: the day with most of the shift; the first such day (the start day) on a tie.
  let best = days[0];
  for (const d of days) if (best === undefined || d.minutes > best.minutes) best = d;
  if (best === undefined) return [];
  const day = fromDayNumber(best.day);
  return isHoliday(day) ? [day] : [];
}

/**
 * Minutes of `window` (normally the worked window) that earn each holiday's premium. 'start'
 * and 'majority' give every minute to the attributed date; 'clock' gives each holiday date
 * the minutes on it. Real minutes when transitions are given (D19).
 */
export function holidayMinutesOn(
  date: IsoDate,
  timing: ShiftTiming,
  window: ShiftWindow,
  attribution: HolidayAttribution,
  isHoliday: (d: IsoDate) => boolean,
  transitions: readonly DstTransition[] = [],
): Map<IsoDate, number> {
  const out = new Map<IsoDate, number>();
  if (attribution !== 'clock') {
    const [holiday] = attributedHolidayDates(date, timing, attribution, isHoliday);
    if (holiday !== undefined) out.set(holiday, realMinutesIn(window, transitions));
    return out;
  }
  for (const { day } of minutesByDay(window)) {
    const holiday = fromDayNumber(day);
    if (!isHoliday(holiday)) continue;
    const onDay: ShiftWindow = {
      startMinute: Math.max(window.startMinute, day * MINUTES_PER_DAY),
      endMinute: Math.min(window.endMinute, (day + 1) * MINUTES_PER_DAY),
    };
    out.set(holiday, realMinutesIn(onDay, transitions));
  }
  return out;
}
