/**
 * Per-day buckets for the overlapping-requests heatmap.
 *
 * A request is an inclusive date range, so a Friday–Sunday request touches three cells; the
 * cell's intensity is how many requests touch it, split by status because three *approved*
 * nurses off on one Saturday is a staffing fact while three *pending* ones is a decision the
 * manager is about to make. Done here as pure data (no JSX) so the inclusive-range arithmetic
 * is unit-tested independently of how the cells are painted. Date stepping goes through core's
 * `addDays`, never a local `Date`.
 */

import type { IsoDate, TimeOffRequest } from '@shiftnurse/core';
import { addDays, compareDates, datesInRange } from '@shiftnurse/core';

export interface HeatmapDay {
  date: IsoDate;
  approved: number;
  pending: number;
  /** Ids of every request touching this day, whatever its status — what a click filters to. */
  requestIds: string[];
}

/** One bucket per day of `[start, end]`, in order. Denied and cancelled requests are ignored. */
export function bucketByDay(
  requests: readonly TimeOffRequest[],
  start: IsoDate,
  end: IsoDate,
): HeatmapDay[] {
  const days = datesInRange(start, end).map<HeatmapDay>((date) => ({
    date,
    approved: 0,
    pending: 0,
    requestIds: [],
  }));
  const index = new Map(days.map((d, i) => [d.date, i]));
  for (const request of requests) {
    if (request.status !== 'approved' && request.status !== 'pending') continue;
    const from = compareDates(request.startDate, start) < 0 ? start : request.startDate;
    const to = compareDates(request.endDate, end) > 0 ? end : request.endDate;
    for (let date = from; compareDates(date, to) <= 0; date = addDays(date, 1)) {
      const i = index.get(date);
      if (i === undefined) continue;
      const day = days[i]!;
      if (request.status === 'approved') day.approved += 1;
      else day.pending += 1;
      day.requestIds.push(request.id);
    }
  }
  return days;
}

export interface HeatmapCell {
  date: IsoDate;
  /** Absent for the padding cells before the range starts or after it ends. */
  day?: HeatmapDay;
}

/**
 * Group the days into Sunday-first calendar weeks, padding the first and last with dated but
 * empty cells so every column is a weekday and every cell has a stable key.
 */
export function weeksOf(
  days: readonly HeatmapDay[],
  weekday: (date: IsoDate) => number,
): HeatmapCell[][] {
  const first = days[0];
  if (first === undefined) return [];
  const cells: HeatmapCell[] = [];
  const lead = weekday(first.date);
  for (let i = lead; i > 0; i -= 1) cells.push({ date: addDays(first.date, -i) });
  for (const day of days) cells.push({ date: day.date, day });
  const last = cells[cells.length - 1]!;
  for (let i = 1; cells.length % 7 !== 0; i += 1) cells.push({ date: addDays(last.date, i) });
  const weeks: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** "3 approved, 2 pending" / "no requests" — the accessible label and tooltip text. */
export function describeDay(day: HeatmapDay): string {
  if (day.approved === 0 && day.pending === 0) return 'no requests';
  const parts: string[] = [];
  if (day.approved > 0) parts.push(`${day.approved} approved`);
  if (day.pending > 0) parts.push(`${day.pending} pending`);
  return parts.join(', ');
}
