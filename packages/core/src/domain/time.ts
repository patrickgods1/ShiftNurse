/**
 * Calendar and shift-time arithmetic.
 *
 * ## Why this module exists
 *
 * Nurse scheduling contracts are written in **wall-clock time**: "at least 10 hours
 * between shifts", "no more than 4 consecutive 12-hour shifts". They are not written in
 * absolute instants. If we modelled shifts as UTC timestamps, the twice-yearly DST
 * transitions would silently make one night shift 11 hours and another 13, and every
 * rest-period and consecutive-hours calculation would drift by an hour for one day a year.
 *
 * So we model the schedule on a **continuous local wall-clock timeline**: minute zero is
 * midnight on 1970-01-01 local time, and every day is exactly 1440 minutes long. A shift's
 * paid duration comes from its declared `durationHours`, never from subtracting two
 * timestamps. DST simply does not exist in this coordinate system, which is precisely how
 * the contract language treats it.
 *
 * Calendar arithmetic (adding days, finding weekdays) is done through `Date.UTC`, which is
 * also DST-free. We never construct a local-timezone `Date` for scheduling maths.
 *
 * Where real instants genuinely matter — a timestamp on an audit log entry, when a call-off
 * was phoned in — use `Date`/epoch millis directly. Those are events, not schedule geometry.
 */

/** A calendar date in `YYYY-MM-DD` form. Branded so it can't be confused with any string. */
export type IsoDate = string & { readonly __isoDate: unique symbol };

/** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_HOUR = 60;
export const MS_PER_DAY = 86_400_000;

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY_RE = /^(\d{2}):(\d{2})$/;

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

/** Validate and brand a `YYYY-MM-DD` string. Throws on anything else. */
export function isoDate(value: string): IsoDate {
  if (!ISO_DATE_RE.test(value)) {
    throw new RangeError(`Invalid ISO date "${value}" (expected YYYY-MM-DD)`);
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const round = new Date(utc);
  // Rejects 2025-02-30 and friends, which Date.UTC would silently roll over.
  if (round.getUTCFullYear() !== y || round.getUTCMonth() !== m - 1 || round.getUTCDate() !== d) {
    throw new RangeError(`Invalid calendar date "${value}"`);
  }
  return value as IsoDate;
}

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE_RE.test(value)) return false;
  try {
    isoDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Both directions are memoised. A schedule touches a few dozen distinct dates, but the solver
 * and the rule engine convert them millions of times per run (every `compareDates`, every
 * `datesInRange` for a partial view); without the cache, parsing ISO strings was over half of
 * a solve. The maps are bounded by the number of distinct dates ever seen, which is tiny.
 */
const DAY_NUMBER_CACHE = new Map<string, number>();
const ISO_DATE_CACHE = new Map<number, IsoDate>();

/** Whole days since 1970-01-01. The canonical integer form of a calendar date. */
export function dayNumber(date: IsoDate): number {
  const cached = DAY_NUMBER_CACHE.get(date);
  if (cached !== undefined) return cached;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const value = Date.UTC(y, m - 1, d) / MS_PER_DAY;
  DAY_NUMBER_CACHE.set(date, value);
  return value;
}

export function fromDayNumber(days: number): IsoDate {
  const cached = ISO_DATE_CACHE.get(days);
  if (cached !== undefined) return cached;
  const dt = new Date(days * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const value = `${y}-${m}-${d}` as IsoDate;
  ISO_DATE_CACHE.set(days, value);
  return value;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(dayNumber(date) + days);
}

/** `b - a`, in whole days. Negative when `b` precedes `a`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return dayNumber(b) - dayNumber(a);
}

export function weekdayOf(date: IsoDate): Weekday {
  return new Date(dayNumber(date) * MS_PER_DAY).getUTCDay() as Weekday;
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return dayNumber(a) - dayNumber(b);
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return dayNumber(a) <= dayNumber(b) ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return dayNumber(a) >= dayNumber(b) ? a : b;
}

/** Inclusive on both ends. Returns `[]` if `end` precedes `start`. */
export function datesInRange(start: IsoDate, end: IsoDate): IsoDate[] {
  const from = dayNumber(start);
  const to = dayNumber(end);
  if (to < from) return [];
  const out: IsoDate[] = [];
  for (let n = from; n <= to; n++) out.push(fromDayNumber(n));
  return out;
}

/** Inclusive range containment. */
export function dateInRange(date: IsoDate, start: IsoDate, end: IsoDate): boolean {
  const n = dayNumber(date);
  return n >= dayNumber(start) && n <= dayNumber(end);
}

export function rangesOverlap(
  aStart: IsoDate,
  aEnd: IsoDate,
  bStart: IsoDate,
  bEnd: IsoDate,
): boolean {
  return dayNumber(aStart) <= dayNumber(bEnd) && dayNumber(bStart) <= dayNumber(aEnd);
}

/** Today's date in the host's local timezone, as an `IsoDate`. */
export function today(now: Date = new Date()): IsoDate {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}` as IsoDate;
}

// ---------------------------------------------------------------------------
// Times of day
// ---------------------------------------------------------------------------

/** `"19:00"` → `1140`. Minutes since local midnight. */
export function parseTimeOfDay(value: string): number {
  const match = TIME_OF_DAY_RE.exec(value);
  if (!match) throw new RangeError(`Invalid time of day "${value}" (expected HH:MM)`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new RangeError(`Invalid time of day "${value}"`);
  }
  return hours * MINUTES_PER_HOUR + minutes;
}

/** `1140` → `"19:00"`. Accepts values past midnight and wraps them. */
export function formatTimeOfDay(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(wrapped / MINUTES_PER_HOUR);
  const m = wrapped % MINUTES_PER_HOUR;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function hoursToMinutes(hours: number): number {
  return Math.round(hours * MINUTES_PER_HOUR);
}

export function minutesToHours(minutes: number): number {
  return minutes / MINUTES_PER_HOUR;
}

// ---------------------------------------------------------------------------
// Shift windows on the continuous local timeline
// ---------------------------------------------------------------------------

/** The timing facts of a shift type, decoupled from the full entity for testability. */
export interface ShiftTiming {
  /** Local clock start, `HH:MM`. */
  readonly startTime: string;
  /** Paid/scheduled length. Declared, never derived from timestamps. */
  readonly durationHours: number;
}

/**
 * A half-open interval `[startMinute, endMinute)` on the continuous local timeline,
 * where minute 0 is midnight beginning 1970-01-01.
 */
export interface ShiftWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** True when the shift runs past local midnight into the following calendar day. */
export function crossesMidnight(timing: ShiftTiming): boolean {
  return parseTimeOfDay(timing.startTime) + hoursToMinutes(timing.durationHours) > MINUTES_PER_DAY;
}

/**
 * Place a shift type on a calendar date, yielding its absolute window.
 *
 * `date` is always the date the shift **starts**. A night shift dated Friday runs into
 * Saturday morning; it is still "Friday's night shift", which is how units talk about it
 * and how it must be printed on the grid.
 */
export function shiftWindow(date: IsoDate, timing: ShiftTiming): ShiftWindow {
  if (!(timing.durationHours > 0)) {
    throw new RangeError(`Shift duration must be positive, got ${timing.durationHours}`);
  }
  const startMinute = dayNumber(date) * MINUTES_PER_DAY + parseTimeOfDay(timing.startTime);
  return { startMinute, endMinute: startMinute + hoursToMinutes(timing.durationHours) };
}

export function windowDurationMinutes(window: ShiftWindow): number {
  return window.endMinute - window.startMinute;
}

/** Half-open overlap: a shift ending at 07:00 does not overlap one starting at 07:00. */
export function windowsOverlap(a: ShiftWindow, b: ShiftWindow): boolean {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

/**
 * Gap between two shift windows, in minutes. Negative if they overlap.
 * Order-independent: whichever window starts later is treated as the second shift.
 */
export function restMinutesBetween(a: ShiftWindow, b: ShiftWindow): number {
  const [first, second] = a.startMinute <= b.startMinute ? [a, b] : [b, a];
  return second.startMinute - first.endMinute;
}

/** The calendar date a window ends on — the morning a night shift actually finishes. */
export function windowEndDate(window: ShiftWindow): IsoDate {
  // A shift ending exactly at midnight ends on the day it was working, not the next one.
  const endMinuteInclusive = window.endMinute - 1;
  return fromDayNumber(Math.floor(endMinuteInclusive / MINUTES_PER_DAY));
}

/** Every calendar date a window touches, in order. */
export function datesTouchedByWindow(window: ShiftWindow): IsoDate[] {
  const first = Math.floor(window.startMinute / MINUTES_PER_DAY);
  const last = Math.floor((window.endMinute - 1) / MINUTES_PER_DAY);
  const out: IsoDate[] = [];
  for (let n = first; n <= last; n++) out.push(fromDayNumber(n));
  return out;
}

// ---------------------------------------------------------------------------
// Weekends
// ---------------------------------------------------------------------------

/**
 * What counts as "a weekend shift" for equity tracking.
 *
 * Contracts disagree about this and it is worth real money, so it is configuration rather
 * than a hardcoded Saturday/Sunday test. A Friday 19:00–07:00 night shift is a weekend
 * shift under many nursing contracts but not all.
 *
 * - `mode: 'starts_within'` — the shift counts if it *begins* inside the weekend window.
 * - `mode: 'overlaps'`      — the shift counts if any part of it falls in the window.
 */
export interface WeekendDefinition {
  /** Weekday the weekend window opens on. */
  readonly startWeekday: Weekday;
  /** Minutes past midnight on `startWeekday` that the window opens. */
  readonly startMinute: number;
  /** Length of the weekend window in minutes. */
  readonly durationMinutes: number;
  readonly mode: 'starts_within' | 'overlaps';
}

/** Saturday 00:00 through Monday 00:00, counted by shift start. */
export const DEFAULT_WEEKEND: WeekendDefinition = {
  startWeekday: 6,
  startMinute: 0,
  durationMinutes: 2 * MINUTES_PER_DAY,
  mode: 'starts_within',
};

/**
 * The weekend window containing or immediately preceding a given absolute minute.
 * Used to test membership and to identify *which* weekend a shift belongs to.
 */
function weekendWindowFor(absoluteMinute: number, def: WeekendDefinition): ShiftWindow {
  const day = Math.floor(absoluteMinute / MINUTES_PER_DAY);
  const weekday = new Date(day * MS_PER_DAY).getUTCDay();
  // Days back to the most recent `startWeekday`.
  const daysBack = (weekday - def.startWeekday + 7) % 7;
  let start = (day - daysBack) * MINUTES_PER_DAY + def.startMinute;
  if (start > absoluteMinute) start -= 7 * MINUTES_PER_DAY;
  return { startMinute: start, endMinute: start + def.durationMinutes };
}

export function isWeekendWindow(
  window: ShiftWindow,
  def: WeekendDefinition = DEFAULT_WEEKEND,
): boolean {
  const candidate = weekendWindowFor(window.startMinute, def);
  if (def.mode === 'starts_within') {
    return window.startMinute >= candidate.startMinute && window.startMinute < candidate.endMinute;
  }
  // 'overlaps' must also consider the weekend window that starts after this shift begins.
  const next: ShiftWindow = {
    startMinute: candidate.startMinute + 7 * MINUTES_PER_DAY,
    endMinute: candidate.endMinute + 7 * MINUTES_PER_DAY,
  };
  return windowsOverlap(window, candidate) || windowsOverlap(window, next);
}

/**
 * A stable identifier for *which* weekend a shift belongs to, or `null` if it is not a
 * weekend shift. Counting distinct values per nurse is how "every other weekend" is enforced.
 */
export function weekendKey(
  window: ShiftWindow,
  def: WeekendDefinition = DEFAULT_WEEKEND,
): string | null {
  if (!isWeekendWindow(window, def)) return null;
  const candidate = weekendWindowFor(window.startMinute, def);
  return fromDayNumber(Math.floor(candidate.startMinute / MINUTES_PER_DAY));
}

export function isWeekendDate(date: IsoDate): boolean {
  const w = weekdayOf(date);
  return w === 0 || w === 6;
}
