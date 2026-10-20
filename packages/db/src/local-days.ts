/**
 * Real instants against local calendar days. Audit and call-log times are epoch millis, but a
 * manager's date range ("since Jan 1") is local days. `dayNumber(d) * MS_PER_DAY` is UTC
 * midnight, so in New York a call at 22:00 on Dec 31 would read as "since Jan 1". Without one
 * place for the conversion, each reader pads or forgets to pad on its own.
 *
 * The SQL window is over-wide on purpose (every UTC offset fits in 36 hours); `onLocalDays`
 * then settles the edges with core's `today(date)`, the same conversion the daily backup uses.
 */

import {
  compareDates,
  dayNumber,
  type IsoDate,
  isIsoDate,
  MS_PER_DAY,
  today,
} from '@shiftnurse/core';

/** A day and a half: covers every UTC offset, so the SQL window never cuts a local day. */
export const LOCAL_DAY_PAD_MS = 36 * 3_600_000;

/**
 * Epoch-ms bounds that contain every instant falling on a local day in [start, end] (end
 * omitted: open-ended). Over-wide by design; settle the edges with `onLocalDays`.
 */
export function instantWindow(
  start: IsoDate,
  end?: IsoDate,
): { from: number; to: number | undefined } {
  return {
    from: dayNumber(start) * MS_PER_DAY - LOCAL_DAY_PAD_MS,
    to: end === undefined ? undefined : (dayNumber(end) + 1) * MS_PER_DAY + LOCAL_DAY_PAD_MS,
  };
}

/** Whether the instant falls, in the host's zone, on a calendar day in [start, end]. */
export function onLocalDays(at: number, start: IsoDate, end?: IsoDate): boolean {
  const day = today(new Date(at));
  return compareDates(day, start) >= 0 && (end === undefined || compareDates(day, end) <= 0);
}

/**
 * The epoch ms of wall-clock `time` (`HH:MM`) on `date` in the host's zone. A local `Date` is
 * right here, unlike in schedule maths: this is an event instant (when a call was made), not
 * schedule geometry, and events are displayed in the host's zone, so 05:00 on the shift's date
 * must read 05:00 on the manager's clock. A time inside a spring-forward gap resolves forward.
 */
export function localInstant(date: IsoDate, time: string): number {
  if (!isIsoDate(date)) throw new Error(`"${date}" is not a date.`);
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`"${time}" is not a time of day.`);
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(y!, mo! - 1, d!, Number(m[1]), Number(m[2])).getTime();
}

/** A recorded event time is a real instant in whole milliseconds; NaN or 1.5 is a caller bug. */
export function requireWholeMillis(at: number): void {
  if (!Number.isSafeInteger(at)) {
    throw new Error('A recorded time must be a whole number of milliseconds.');
  }
}
