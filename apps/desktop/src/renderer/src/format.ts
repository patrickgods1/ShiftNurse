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

import { type IsoDate, isIsoDate, type Nurse, weekdayOf } from '@shiftnurse/core';

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

const MONTH_FULL_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2026-11-01" -> "November 2026": the band over the grid's date row. */
export function formatMonthYear(date: IsoDate | string): string {
  const [year, month] = date.split('-');
  return `${MONTH_FULL_NAMES[Number(month) - 1] ?? '?'} ${year}`;
}

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

/** "Campbell, Grace": every list and table, sorted and read the way the unit calls the roster. */
export function listName(nurse: Pick<Nurse, 'firstName' | 'lastName'>): string {
  return `${nurse.lastName}, ${nurse.firstName}`;
}

/** "0.9 FTE", or what a nurse with no contracted hours is: per diem, agency. */
export function fteLabel(nurse: Pick<Nurse, 'employmentType' | 'fte'>): string {
  if (nurse.employmentType === 'per_diem') return 'Per diem';
  if (nurse.employmentType === 'agency') return 'Agency';
  return `${nurse.fte.toFixed(1)} FTE`;
}

function monthDay(date: IsoDate | string): string {
  const [, m, d] = date.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${Number(d)}`;
}

/** "Oct 4 – Nov 14, 2026": the year once when both ends share it. */
export function periodRange(period: { startDate: string; endDate: string }): string {
  const [startYear, endYear] = [period.startDate.slice(0, 4), period.endDate.slice(0, 4)];
  return startYear === endYear
    ? `${monthDay(period.startDate)} – ${monthDay(period.endDate)}, ${endYear}`
    : `${formatDate(period.startDate)} – ${formatDate(period.endDate)}`;
}

/** Names the app generated from ISO dates ("Schedule 2026-10-04 to …", "Pay period 2026-09-20"). */
const GENERATED_NAME = /^(Schedule|Pay period) \d{4}-\d{2}-\d{2}/;

/** A period as a manager reads it: its dates, after the name only when someone chose one. */
export function periodLabel(period: { name: string; startDate: string; endDate: string }): string {
  const range = periodRange(period);
  return GENERATED_NAME.test(period.name) ? range : `${period.name} (${range})`;
}

// Real instants (audit, backup and request timestamps, epoch millis) are events, not schedule
// geometry, so the host's own zone and locale are right for them — unlike an `IsoDate`, which
// must never be turned into a `Date`. One formatter keeps every screen reading alike.
/** The instant formatter; the arguments exist so tests can pin locale and zone. */
export function instantFormat(locales?: string, timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locales, { dateStyle: 'medium', timeStyle: 'short', timeZone });
}

const INSTANT = instantFormat();

/** "Oct 3, 2026, 5:35 PM". */
export function formatInstant(ms: number): string {
  return INSTANT.format(ms);
}

/** 90 -> "1h 30m", 45 -> "45m", 120 -> "2h". The one wording for a holdover's length. */
export function formatHoldover(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
