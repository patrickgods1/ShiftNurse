/**
 * `on-call-limit` for CP-SAT, when a rule set makes it hard (while soft it is priced instead, one
 * Boolean per judged count or window, by `onCallLimitTerms` in `objective.ts`, from the same
 * `onCallLimitParts`).
 *
 * The rule counts turns on call — entries whose type `isOnCall`, lookback tail and other units'
 * call included — and judges only what holds one of this schedule's turns. Every variable is one of
 * those, so a count that grows past its cap because of a variable is always judged.
 *
 * - **A week** (`workWeekOf`) is `Σ entries in it ≤ max`, for each week holding an in-period entry.
 * - **The schedule** is `Σ entries dated in it ≤ max`; the lookback tail is dated before it.
 * - **Days in a row** is the rule's window: for every `max + 1` consecutive dates, at most `max` of
 *   them on call. A date is on call when any constant on call is dated on it (1), otherwise it is
 *   the sum of that date's on-call variables, which one shift a day keeps at most 1 — as
 *   `encodeConsecutive` reads a day worked.
 *
 * Hard, each is `atMost`: where the constants alone are already over (a published week or a pinned
 * run), every variable that would add to it is forbidden and the standing breach is left to stand,
 * so all off stays feasible — exactly what the gate tolerates (a breach naming only pinned shifts,
 * not growing). A window with a variable is over only when that variable is on, which makes it one
 * of this schedule's, so the window is one the rule judges.
 */

import { dateInRange, fromDayNumber, type IsoDate } from '../../../domain/time.js';
import { workWeekOf } from '../../../rules/hours-rules.js';
import { type OnCallLimitParams, onCallLimitRule } from '../../../rules/on-call-limit.js';
import { asParams } from '../../../rules/registry.js';
import { type Expr, expr, sum } from '../builder.js';
import { countExpr, type EncodeContext, type TimelineEntry } from '../context.js';

/** A capped count: a week's or the schedule's turns on call. */
export interface OnCallCount {
  /** Every turn on call it counts, constants folded in. */
  count: Expr;
  /** The in-period ones (variables, and locked rows): the count is judged only when ≥ 1. */
  inPeriod: Expr;
  max: number;
  label: string;
}

/** One window of `max + 1` consecutive dates: a finding when every date is on call. */
export interface OnCallWindow {
  /** Per date: 1 when on call (a constant, or the date's on-call variables). */
  days: Expr[];
  /** Per date: 1 when one of this schedule's turns on call is on it. */
  inPeriod: Expr[];
  max: number;
  label: string;
}

export interface OnCallParts {
  counts: OnCallCount[];
  windows: OnCallWindow[];
}

/**
 * The judged counts and windows of nurse `n`. Shared so the hard encoder and the price cannot
 * disagree on what is counted or which weeks and windows are judged.
 */
export function onCallLimitParts(
  ctx: EncodeContext,
  n: number,
  params: OnCallLimitParams,
): OnCallParts {
  const out: OnCallParts = { counts: [], windows: [] };
  const calls = ctx.timeline(n).filter((e) => e.shiftType.isOnCall);
  if (!calls.some((e) => e.inPeriod)) return out;
  const name = ctx.name(n);
  const own = (entries: readonly TimelineEntry[]) => countExpr(entries.filter((e) => e.inPeriod));

  const weekCap = params.maxOnCallPerWeek;
  if (weekCap !== undefined) {
    const weeks = new Map<IsoDate, TimelineEntry[]>();
    for (const e of calls) {
      const start = workWeekOf(e.date, params.workWeekStartsOn).start;
      const list = weeks.get(start);
      if (list) list.push(e);
      else weeks.set(start, [e]);
    }
    for (const [start, entries] of weeks) {
      if (!entries.some((e) => e.inPeriod)) continue;
      out.counts.push({
        count: countExpr(entries),
        inPeriod: own(entries),
        max: weekCap,
        label: `on call per week: ${name} week of ${start}`,
      });
    }
  }

  const periodCap = params.maxOnCallPerPeriod;
  if (periodCap !== undefined) {
    const { startDate, endDate } = ctx.input.period;
    const entries = calls.filter((e) => dateInRange(e.date, startDate, endDate));
    out.counts.push({
      count: countExpr(entries),
      inPeriod: own(entries),
      max: periodCap,
      label: `on call per schedule: ${name}`,
    });
  }

  const runCap = params.maxConsecutiveOnCallDays;
  if (runCap !== undefined) {
    const byDay = new Map<number, TimelineEntry[]>();
    for (const e of calls) {
      const list = byDay.get(e.day);
      if (list) list.push(e);
      else byDay.set(e.day, [e]);
    }
    const inDays = calls.filter((e) => e.inPeriod).map((e) => e.day);
    const firstIn = Math.min(...inDays);
    const lastIn = Math.max(...inDays);
    for (let s = firstIn - runCap; s <= lastIn; s++) {
      const days: Expr[] = [];
      const inPeriod: Expr[] = [];
      for (let d = s; d <= s + runCap; d++) {
        const entries = byDay.get(d) ?? [];
        days.push(onCallOn(entries, () => true));
        inPeriod.push(onCallOn(entries, (e) => e.inPeriod));
      }
      // A date nothing puts on call, or a window with none of this schedule's turns, is never one.
      if (days.some((e) => isZero(e)) || inPeriod.every((e) => isZero(e))) continue;
      out.windows.push({
        days,
        inPeriod,
        max: runCap,
        label: `on call in a row: ${name} ${runCap + 1} days from ${fromDayNumber(s)}`,
      });
    }
  }
  return out;
}

/**
 * 1 when a constant among `entries` that `counts` is dated on the day, else the sum of the
 * counted variables (at most 1: one shift a day).
 */
function onCallOn(entries: readonly TimelineEntry[], counts: (e: TimelineEntry) => boolean): Expr {
  const counted = entries.filter(counts);
  if (counted.some((e) => e.literal === null)) return expr([], 1);
  return expr(counted.map((e) => [e.literal!, 1]));
}

function isZero(e: Expr): boolean {
  return e.terms.length === 0 && e.constant === 0;
}

export function encodeOnCallLimit(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(onCallLimitRule, raw);
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const { counts, windows } = onCallLimitParts(ctx, n, params);
    for (const c of counts) ctx.b.atMost(c.count, c.max, c.label);
    for (const w of windows) ctx.b.atMost(sum(...w.days), w.max, w.label);
  }
}
