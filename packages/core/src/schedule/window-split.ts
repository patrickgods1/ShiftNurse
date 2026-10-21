/**
 * Where a shift's worked minutes fall when it runs over the edge of a work week or pay period
 * (D17, 29 CFR 778.104): the FLSA counts each hour in the week it was worked, so the first five
 * hours of a Saturday 19:00 night belong to the old week and the Sunday hours to the new one.
 *
 * Pay, the weekly-hours rule and both solvers read these, so the overtime the rule flags is the
 * overtime payroll pays. Before they shared it, the rule and the solvers put the whole night in
 * its start week at declared hours while pay split it by the clock in real minutes, and on a
 * week-crossing night the two disagreed by the hours past midnight. Built on `realMinutesIn`
 * directly, never on pay's own count of a view's minutes, so a pay-only option cannot leak into
 * the rules.
 */

import {
  dayNumber,
  fromDayNumber,
  type IsoDate,
  MINUTES_PER_DAY,
  type ShiftWindow,
} from '../domain/time.js';
import { type DstTransition, realMinutesIn } from './real-minutes.js';

/** Anything with a worked wall-clock window: an `AssignmentView`, a CP-SAT timeline entry. */
export interface Windowed {
  window: ShiftWindow;
}

/**
 * Real minutes of [from, to) clamped to [start, end): how far into a window starting at `start`
 * the wall minute `to` lies, in minutes actually worked. Lets a wall-clock boundary (a weekend's
 * edge) be compared with a count of real minutes.
 */
export function realOffset(
  start: number,
  end: number,
  to: number,
  tz: readonly DstTransition[],
): number {
  const clamped = Math.min(Math.max(to, start), end);
  return realMinutesIn({ startMinute: start, endMinute: clamped }, tz);
}

/**
 * The wall minute a window dated `date` begins at: `startMinute` minutes after that date's
 * midnight (the work week's start time; 29 CFR 778.105 lets a workweek begin "at any hour").
 * Payroll often starts the week at a shift change (Saturday 19:00, Sunday 07:00) so no night is
 * split; 0 is midnight, the reading before the start time existed.
 */
export function windowBoundaryMinute(date: IsoDate, startMinute = 0): number {
  return dayNumber(date) * MINUTES_PER_DAY + startMinute;
}

/**
 * The date whose window-day holds wall minute `atMinute`, a window-day running from `startMinute`
 * on that date to `startMinute` the next. Which window a shift belongs to under the start
 * reading, and which window's records authorise it, go by the window-day of its start instant:
 * with a Saturday 19:00 start, a Saturday 07:00 day shift is filed under Friday (the old week)
 * and the Saturday 19:00 night under Saturday (the new one). At 0 it is the shift's own date.
 */
export function windowDayOf(atMinute: number, startMinute = 0): IsoDate {
  return fromDayNumber(Math.floor((atMinute - startMinute) / MINUTES_PER_DAY));
}

/**
 * Paid minutes of a view worked before the boundary that opens `edge`, a window's first date, at
 * `startMinute` (`windowBoundaryMinute`). The one split point of a shift across a week or
 * pay-period edge (D17): overtime attribution and the regular rate both read it. Real minutes, so
 * a clock change after the edge (US fall-back is Sunday 02:00) lands in the next window; a
 * boundary inside the repeated hour is read as `realMinutesIn` reads a wall minute there, after
 * the repeat.
 */
export function minutesBeforeEdge(
  view: Windowed,
  edge: IsoDate,
  tz: readonly DstTransition[],
  startMinute = 0,
): number {
  return realOffset(
    view.window.startMinute,
    view.window.endMinute,
    windowBoundaryMinute(edge, startMinute),
    tz,
  );
}

/**
 * A view's real worked minutes either side of the boundary that opens the next window: what it
 * gives its own week (or pay period) and what it carries into the next. `[720, 0]` for a shift
 * that does not reach the edge.
 */
export function splitMinutes(
  view: Windowed,
  nextWindowStart: IsoDate,
  tz: readonly DstTransition[],
  startMinute = 0,
): [before: number, after: number] {
  const before = minutesBeforeEdge(view, nextWindowStart, tz, startMinute);
  return [before, realMinutesIn(view.window, tz) - before];
}

/**
 * Real worked minutes of a view between the boundary opening `start` and the one opening
 * `nextStart`: a window's share of a shift by the clock, whichever edge (or neither) it crosses.
 */
export function minutesInWindow(
  view: Windowed,
  start: IsoDate,
  nextStart: IsoDate,
  tz: readonly DstTransition[],
  startMinute = 0,
): number {
  return (
    minutesBeforeEdge(view, nextStart, tz, startMinute) -
    minutesBeforeEdge(view, start, tz, startMinute)
  );
}
