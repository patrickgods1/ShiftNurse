/**
 * `max-hours-in-24` for CP-SAT, when a rule set makes it hard (while soft it is not priced, so
 * Generate ignores it and the grid flags it — the same stated limit as `tour-rotation`).
 *
 * The rule's hours in a window are Σ overlap minutes, a piecewise-linear function of the
 * window's start whose maximum sits at some shift's start or some shift's end − 1440 (see
 * `rules/hours-in-24.ts`). So the encoding is one linear constraint per such anchor over the
 * nurse's worked timeline: Σ x·overlapMinutes + constantMinutes ≤ maxHours·60, in whole
 * minutes. Constants are locked shifts and the lookback tail, counted as worked (holdovers
 * included, since `TimelineEntry.window` is the worked window); an anchor with no variable in it
 * is left alone, as `forbidPair` leaves two constants alone, so a locked or historical breach
 * cannot make the model infeasible. An anchor whose every entry together stays under the cap
 * can never bind and writes nothing. Hours are hours worked: on the DST nights the real minutes
 * (`schedule/real-minutes.ts`, D19), the window itself on the wall clock, so each coefficient is
 * the minutes the rule counts for that entry and the two cannot disagree on a fall-back night.
 */

import { MINUTES_PER_DAY, MINUTES_PER_HOUR } from '../../../domain/time.js';
import { maxHoursIn24Rule } from '../../../rules/hours-in-24.js';
import { asParams } from '../../../rules/registry.js';
import { type DstTransition, realMinutesIn } from '../../../schedule/real-minutes.js';
import { type Expr, expr } from '../builder.js';
import type { EncodeContext, TimelineEntry } from '../context.js';

export function encodeHoursIn24(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(maxHoursIn24Rule, raw);
  const limit = Math.floor(params.maxHours * MINUTES_PER_HOUR + 1e-6);
  const tz = ctx.model.ctx.dstTransitions;

  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const timeline = ctx.timeline(n).filter((e) => !e.shiftType.isOnCall);

    const anchors = new Set<number>();
    for (const e of timeline) {
      anchors.add(e.window.startMinute);
      anchors.add(e.window.endMinute - MINUTES_PER_DAY);
    }

    for (const from of anchors) {
      const e: Expr = expr();
      let total = 0;
      for (const entry of timeline) {
        if (entry.window.startMinute >= from + MINUTES_PER_DAY) break;
        const minutes = overlapMinutes(entry, from, tz);
        if (minutes === null) continue;
        total += minutes;
        if (entry.literal === null) e.constant += minutes;
        else e.terms.push([entry.literal, minutes]);
      }
      if (e.terms.length === 0 || total <= limit) continue;
      ctx.b.atMost(
        e,
        limit,
        `hours in 24: ${ctx.name(n)} from minute ${from} (${params.maxHours}h cap)`,
      );
    }
  }
}

/** Real minutes of an entry inside the wall window `[from, from + 1440)`; null when outside it. */
function overlapMinutes(
  entry: TimelineEntry,
  from: number,
  tz: readonly DstTransition[],
): number | null {
  const lo = Math.max(entry.window.startMinute, from);
  const hi = Math.min(entry.window.endMinute, from + MINUTES_PER_DAY);
  if (hi <= lo) return null;
  return realMinutesIn({ startMinute: lo, endMinute: hi }, tz);
}
