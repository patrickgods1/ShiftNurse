/**
 * The US federal holidays for a year, for the one-click "add holidays" option in setup.
 *
 * Holidays drive holiday differentials and the holiday-rotation fairness term, so a unit that
 * starts with none is silently paying straight time on Christmas. Most of the list floats
 * ("third Monday in January"), and typing eleven dates by hand each year is where a manager
 * puts Memorial Day on the wrong Monday.
 *
 * Dates are the holiday itself, not the federal *observed* day: a hospital runs on Saturday
 * July 4th regardless, and whether a contract pays the holiday rate on the 3rd or the 4th is
 * a local term the manager edits afterwards. Calendar maths goes through `domain/time.ts`
 * (UTC-based) — never a local `Date`.
 */

import { addDays, type IsoDate, isoDate, type Weekday, weekdayOf } from '../domain/time.js';

export interface HolidayPreset {
  date: IsoDate;
  name: string;
  /** The four holidays contracts most often rotate with stricter equity. */
  isMajor: boolean;
}

const MONDAY: Weekday = 1;
const THURSDAY: Weekday = 4;

function firstOfMonth(year: number, month: number): IsoDate {
  return isoDate(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`);
}

/** The `n`th `weekday` of a month (1-based). */
function nthWeekday(year: number, month: number, weekday: Weekday, n: number): IsoDate {
  const first = firstOfMonth(year, month);
  const offset = (weekday - weekdayOf(first) + 7) % 7;
  return addDays(first, offset + 7 * (n - 1));
}

/** The last `weekday` of a month. */
function lastWeekday(year: number, month: number, weekday: Weekday): IsoDate {
  const nextFirst = month === 12 ? firstOfMonth(year + 1, 1) : firstOfMonth(year, month + 1);
  const last = addDays(nextFirst, -1);
  return addDays(last, -((weekdayOf(last) - weekday + 7) % 7));
}

function fixed(year: number, month: number, day: number): IsoDate {
  return addDays(firstOfMonth(year, month), day - 1);
}

/** The eleven federal holidays of `year`, in date order. */
export function usFederalHolidays(year: number): HolidayPreset[] {
  const h = (date: IsoDate, name: string, isMajor = false): HolidayPreset => ({
    date,
    name,
    isMajor,
  });
  return [
    h(fixed(year, 1, 1), "New Year's Day", true),
    h(nthWeekday(year, 1, MONDAY, 3), 'Martin Luther King Jr. Day'),
    h(nthWeekday(year, 2, MONDAY, 3), "Presidents' Day"),
    h(lastWeekday(year, 5, MONDAY), 'Memorial Day'),
    h(fixed(year, 6, 19), 'Juneteenth'),
    h(fixed(year, 7, 4), 'Independence Day', true),
    h(nthWeekday(year, 9, MONDAY, 1), 'Labor Day'),
    h(nthWeekday(year, 10, MONDAY, 2), 'Columbus Day'),
    h(fixed(year, 11, 11), 'Veterans Day'),
    h(nthWeekday(year, 11, THURSDAY, 4), 'Thanksgiving Day', true),
    h(fixed(year, 12, 25), 'Christmas Day', true),
  ];
}
