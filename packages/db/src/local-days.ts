/**
 * Real instants against local calendar days. Audit and call-log times are epoch millis, but a
 * manager's date range ("since Jan 1") is local days. `dayNumber(d) * MS_PER_DAY` is UTC
 * midnight, so in New York a call at 22:00 on Dec 31 would read as "since Jan 1". Without one
 * place for the conversion, each reader pads or forgets to pad on its own.
 *
 * The SQL window is over-wide on purpose (every UTC offset fits in 36 hours); `onLocalDays`
 * then settles the edges with core's `today(date)`, the same conversion the daily backup uses.
 */

import { compareDates, dayNumber, type IsoDate, MS_PER_DAY, today } from '@shiftnurse/core';

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
