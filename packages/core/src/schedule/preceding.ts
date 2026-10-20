/**
 * What a shift follows: the shifts that started before it and, among those, end last.
 *
 * Rest is measured from when the nurse last stopped working, and a change of tour from the
 * tour they last stopped on. Comparing each shift with its neighbour in start order gets that
 * wrong whenever one shift sits inside a longer one: a 20:00–22:00 short shift inside a
 * 19:00–07:00 night is the night's start-order neighbour, so a 09:00 start the next morning was
 * measured from 22:00 (11 hours, rested) instead of 07:00 (2 hours). The rest and tour-change
 * rules both walk the timeline through here, so they cannot disagree about where rest begins.
 */

import type { ShiftWindow } from '../domain/time.js';

/**
 * For each shift on a start-sorted timeline, the shifts that started strictly before it and,
 * among those, end last (several when they end at the same minute; empty for the first).
 */
export function latestEndingBefore<T extends { window: ShiftWindow }>(
  timeline: readonly T[],
): (readonly T[])[] {
  const result: (readonly T[])[] = [];
  // The latest-ending shifts among every shift that started before the current group.
  let latest: T[] = [];
  let i = 0;
  while (i < timeline.length) {
    // Shifts starting at the same minute are not before one another (they overlap, which is the
    // overlap rule's business), so a group of equal starts shares one answer. That also keeps
    // the answer independent of how the sort orders ties.
    const start = timeline[i]!.window.startMinute;
    let j = i;
    while (j < timeline.length && timeline[j]!.window.startMinute === start) j++;
    const before: readonly T[] = latest;
    for (let k = i; k < j; k++) result.push(before);
    for (let k = i; k < j; k++) {
      const shift = timeline[k]!;
      const end = latest[0]?.window.endMinute;
      if (end === undefined || shift.window.endMinute > end) latest = [shift];
      else if (shift.window.endMinute === end) {
        // Copy before the first push: `before` is already some shift's answer.
        if (latest === before) latest = [...latest];
        latest.push(shift);
      }
    }
    i = j;
  }
  return result;
}
