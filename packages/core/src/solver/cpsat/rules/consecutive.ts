/**
 * `max-consecutive-shifts`: days in a row, nights in a row, and days off after a full stretch.
 *
 * Stretches are runs of consecutive *start dates* with a worked shift, as the rule builds them.
 * A nurse starts at most one shift per day in this model (the same one-per-day policy the
 * annealer's eligibility filter applies), so "worked on day d" is simply the sum of that day's
 * variables — no auxiliary needed.
 */

import { fromDayNumber } from '../../../domain/time.js';
import type { ConsecutiveShiftsParams } from '../../../rules/rest-rules.js';
import { type Expr, expr, scale, sum } from '../builder.js';
import type { EncodeContext, TimelineEntry } from '../context.js';

export function encodeConsecutive(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = raw as unknown as ConsecutiveShiftsParams;
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
    const day = (d: number): Expr => dayExpr(byDay.get(d), () => true);
    const night = (d: number): Expr => dayExpr(byDay.get(d), (e) => e.shiftType.isNight);
    const name = ctx.name(n);

    // No more than k days in a row: every window of k+1 days holds at most k worked days.
    for (let s = first; s + k <= last; s++) {
      const window = sum(...range(s, s + k).map(day));
      ctx.b.atMost(window, k, `consecutive: ${name} ${k + 1} days from ${fromDayNumber(s)}`);
    }

    // No stretch made entirely of nights longer than m. A stretch is bounded by days off, so for
    // each start a and length L in m+1..k: not (day a−1 off, a..a+L−1 all nights, day a+L off).
    // Longer stretches are already excluded by the day limit above.
    for (let a = first; a <= last; a++) {
      for (let L = m + 1; L <= k; L++) {
        const nights = sum(...range(a, a + L - 1).map(night));
        const offBefore = sum(expr([], 1), scale(day(a - 1), -1));
        const offAfter = sum(expr([], 1), scale(day(a + L), -1));
        ctx.b.atMost(
          sum(nights, offBefore, offAfter),
          L + 1,
          `consecutive nights: ${name} ${L} nights from ${fromDayNumber(a)}`,
        );
      }
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

function dayExpr(entries: TimelineEntry[] | undefined, keep: (e: TimelineEntry) => boolean): Expr {
  const e = expr();
  if (!entries) return e;
  // A constant worked shift that day fixes the day; the model creates no variables beside it.
  const constant = entries.find((x) => x.literal === null);
  if (constant) return expr([], keep(constant) ? 1 : 0);
  for (const x of entries) if (keep(x)) e.terms.push([x.literal!, 1]);
  return e;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}
