/**
 * Display-only date formatting.
 *
 * Schedule arithmetic must never construct a local-timezone `Date` (see the time-model header
 * in packages/core) — but *printing* an ISO string for a human is not arithmetic. This module
 * exists to draw that line: it only ever splits the string or uses `Date.UTC`, so it can never
 * accidentally introduce a timezone-dependent off-by-one into a rest or consecutive-hours
 * calculation elsewhere. Anything beyond splitting the string — weekday, day distance — is
 * delegated to `@shiftnurse/core`'s time helpers rather than re-derived.
 */

import { type IsoDate, isIsoDate, weekdayOf } from '@shiftnurse/core';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "2026-03-05" -> "Mar 5, 2026". */
export function formatDate(date: IsoDate | string): string {
  const parts = date.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day) return date;
  const name = MONTH_NAMES[month - 1] ?? '?';
  return `${name} ${day}, ${year}`;
}

/** "2026-03-05" -> "Thu, Mar 5". Used where the day of week matters more than the year. */
export function formatDateWithWeekday(date: IsoDate | string): string {
  const parts = date.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day || !isIsoDate(date)) return date;
  // Never re-derive weekday arithmetic here: day 0 of the epoch was a Thursday, so a naive
  // `dayNumber % 7` is four days off. Core's `weekdayOf` is the single source of truth.
  const weekday = WEEKDAY_NAMES[weekdayOf(date)] ?? '?';
  const name = MONTH_NAMES[month - 1] ?? '?';
  return `${weekday}, ${name} ${day}`;
}

/** Whole-day distance from today (UTC-based, matching the ISO-date-as-calendar-day model). */
export function daysFromToday(date: IsoDate | string): number {
  const parts = date.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const target = Date.UTC(year, month - 1, day);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}
