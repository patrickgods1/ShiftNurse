/**
 * A call-back is recorded against its standby shift as minutes from that shift's start, but the
 * manager knows the wall clock ("she came in at 02:00"). The conversion lives here, once: a time
 * earlier than the standby's start is the next morning, because a standby dated Friday 19:00 runs
 * into Saturday. A time that falls outside the standby comes out as a large number, which the
 * repository refuses in words; the renderer does not second-guess it.
 */

import { formatTimeOfDay, parseTimeOfDay } from '@shiftnurse/core';

const MINUTES_PER_DAY = 1440;

/** Minutes from the standby's start to `time` (both `HH:MM`), wrapping past midnight. */
export function callBackStartMinute(standbyStart: string, time: string): number {
  const start = parseTimeOfDay(standbyStart);
  const t = parseTimeOfDay(time);
  return t >= start ? t - start : t + MINUTES_PER_DAY - start;
}

/** `now` on the host's wall clock, to the nearest quarter hour, as `HH:MM` (23:58 reads 00:00). */
export function nearestQuarterHour(now: Date): string {
  const minutes = Math.round((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  return formatTimeOfDay(minutes % MINUTES_PER_DAY);
}
