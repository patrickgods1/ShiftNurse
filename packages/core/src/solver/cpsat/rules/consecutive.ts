/**
 * `max-consecutive-shifts`: days in a row, nights in a row, and days off after a full stretch.
 *
 * Stretches are runs of consecutive *start dates* with a worked shift, as the rule builds them.
 * A nurse starts at most one shift per day in this model (the same one-per-day policy the
 * annealer's eligibility filter applies), so "worked on day d" is simply the sum of that day's
 * variables — no auxiliary needed.
 *
 * The night limit is a sliding window over night *dates* (D1), as the rule's `nightRuns` counts
 * them: every m+1 consecutive dates hold at most m worked night tours. A run longer than m
 * contains such a window, and a window full of nights is such a run, so the windows bound the
 * run exactly — wherever it sits beside day shifts, which neither reset nor hide it.
 */

import { fromDayNumber } from '../../../domain/time.js';
import { asParams } from '../../../rules/registry.js';
import { consecutiveShiftsRule } from '../../../rules/rest-rules.js';
import { isNightTour } from '../../../rules/tour-rotation.js';
import { type Expr, expr, sum } from '../builder.js';
import type { EncodeContext, TimelineEntry } from '../context.js';

export function encodeConsecutive(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(consecutiveShiftsRule, raw);
  const k = params.maxConsecutiveShifts;
  const m = params.maxConsecutiveNights;

  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const worked = ctx
      .timeline(n)
      .filter((e) => params.onCallCountsAsWork || !e.shiftType.isOnCall);
    if (worked.length === 0) continue;

    const byDay = new Map<number, TimelineEntry[]>();
    for (const e of worked) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
    const first = Math.min(...byDay.keys());
    const last = Math.max(...byDay.keys());
    const day = (d: number): Expr => dayExpr(byDay.get(d));
    const night = (d: number): Expr => nightExpr(byDay.get(d));
    const name = ctx.name(n);

    // No more than k days in a row: every window of k+1 days holds at most k worked days.
    for (let s = first; s + k <= last; s++) {
      const window = sum(...range(s, s + k).map(day));
      ctx.b.atMost(window, k, `consecutive: ${name} ${k + 1} days from ${fromDayNumber(s)}`);
    }

    // No more than m nights in a row: every window of m+1 dates holds at most m night dates.
    for (let s = first; s + m <= last; s++) {
      const window = sum(...range(s, s + m).map(night));
      ctx.b.atMost(
        window,
        m,
        `consecutive nights: ${name} ${m + 1} nights from ${fromDayNumber(s)}`,
      );
    }

    // After a full k-day stretch ending on day t, days t+2..t+minOff must be off (t+1 working
    // would make the stretch k+1 long, which the day limit forbids already).
    const minOff = params.minDaysOffAfterMaxStretch;
    if (minOff > 0) {
      for (let t = first + k - 1; t <= last; t++) {
        const run = sum(...range(t - k + 1, t).map(day));
        for (let j = 2; j <= minOff; j++) {
          ctx.b.atMost(
            sum(run, day(t + j)),
            k,
            `days off: ${name} back on ${fromDayNumber(t + j)} after a ${k}-day stretch`,
          );
        }
      }
    }
  }
}

function dayExpr(entries: TimelineEntry[] | undefined): Expr {
  const e = expr();
  if (!entries) return e;
  // A constant worked shift that day makes it worked, whatever the variables beside it say. A
  // locked row leaves the nurse no variables that day, but another unit's shift (a constant in
  // the lookback list, dated in the period) does: she keeps her home variables, which is why
  // the night count reads `nightExpr`, not the first constant.
  const constant = entries.find((x) => x.literal === null);
  if (constant) return expr([], 1);
  for (const x of entries) e.terms.push([x.literal!, 1]);
  return e;
}

/**
 * Whether day d is a night date. Unlike `dayExpr`, the first constant does not decide: a day
 * constant listed before a night constant (or beside a night variable) would hide the night and
 * leave the encoder looser than the rule. Any constant worked night makes the date a night; else
 * it is the night variables' sum, which one-shift-a-day keeps at most 1.
 */
function nightExpr(entries: TimelineEntry[] | undefined): Expr {
  const e = expr();
  if (!entries) return e;
  const workedNight = (x: TimelineEntry) => !x.shiftType.isOnCall && isNightTour(x.shiftType);
  if (entries.some((x) => x.literal === null && workedNight(x))) return expr([], 1);
  for (const x of entries) if (x.literal !== null && workedNight(x)) e.terms.push([x.literal, 1]);
  return e;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}
