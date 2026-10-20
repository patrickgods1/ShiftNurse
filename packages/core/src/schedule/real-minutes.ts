/**
 * Real elapsed minutes of a wall-clock window — the one place DST arithmetic lives (D19).
 *
 * The schedule's timeline (`domain/time.ts`) has no DST: every day is 1440 minutes, which is how
 * contracts write rest, overlap and "a 12-hour shift". But the FLSA pays hours actually worked
 * (29 CFR part 785), and the statutory hour caps count them too: the fall-back night 19:00–07:00
 * is 13 hours on the floor, the spring-forward one 11. Without this, pay priced 12 on both nights
 * and a California nurse's thirteenth hour of double time never appeared. Only pay and the caps'
 * hour *totals* ask; everything else stays on the wall clock. Core never reads the host clock, so
 * the host supplies the clock changes.
 */

import type { ShiftWindow } from '../domain/time.js';

/**
 * A change of the local clock. At wall minute `atMinute` (the continuous timeline of
 * domain/time.ts: the reading just before the jump) the clock moves by `deltaMinutes`:
 * +60 springs forward (wall minutes [atMinute, atMinute + 60) never happen), −60 falls back
 * (wall minutes [atMinute − 60, atMinute) happen twice). Supplied by the host (T05); core
 * never reads the host clock.
 */
export interface DstTransition {
  atMinute: number;
  deltaMinutes: number;
}

/** Minutes the half-open windows [aStart, aEnd) and [bStart, bEnd) share. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Real elapsed minutes of the half-open wall window: its wall length, less the skipped wall
 * minutes inside it, plus the repeated ones. Exact for any window that neither starts nor
 * ends inside a skipped or repeated hour (every shift that starts and ends outside 01:00–03:00
 * local); within 60 minutes otherwise. Used by pay and the statutory hour caps only (D19):
 * rule geometry stays on the wall clock.
 */
export function realMinutesIn(window: ShiftWindow, transitions: readonly DstTransition[]): number {
  const { startMinute: start, endMinute: end } = window;
  let minutes = end - start;
  for (const { atMinute: at, deltaMinutes: d } of transitions) {
    if (d > 0) minutes -= overlap(start, end, at, at + d);
    else if (d < 0) minutes += overlap(start, end, at + d, at);
  }
  return minutes;
}
