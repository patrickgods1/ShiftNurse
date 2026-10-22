/**
 * `short-work-runs` for CP-SAT, when a rule set makes it hard (while soft it is priced instead,
 * one Boolean per nurse and candidate run, by `shortWorkRunTerms` in `objective.ts`, from the same
 * `shortWorkRunParts`).
 *
 * A day is worked when any worked entry is dated on it: a constant (lookback, locked, another
 * unit's shift) makes it 1, otherwise it is the sum of that day's variables, which one shift a day
 * keeps at most 1 — as `encodeConsecutive` reads it. A run of exactly L days from day s is
 * `¬w[s−1] ∧ w[s] ∧ … ∧ w[s+L−1] ∧ ¬w[s+L]`, so `pattern = (1 − w[s−1]) + Σ w + (1 − w[s+L])`
 * reaches L + 2 exactly when it holds. The rule judges such a run only when it holds an in-period
 * shift, so it is written per in-period entry `x` dated in it as `pattern + x − (L + 2)`, which is
 * 1 exactly when the run holds with `x` worked and at most 0 otherwise. Every short length
 * (1 … min − 1) and every start whose run could hold an in-period entry is enumerated, sliding as
 * `encodeConsecutive` slides its windows; a start the rule would not judge (`judgesRun`: reaching
 * the last day, or a day before missing from the history) makes none, and neither does one a
 * constant already rules out (a day nothing could work, an edge day already worked).
 *
 * Hard, each part whose `x` is a variable is held at ≤ 0. A part whose `x` is locked is left
 * out: a run made of constants alone is a pinned breach, left to stand (all off stays feasible,
 * as `atMost` treats a standing violation), while every variable that would join or start a short
 * run is still forbidden — exactly what the gate tolerates (a breach naming only pinned shifts).
 * With every variable off no part with a variable `x` can be positive, so all off is feasible.
 *
 * As in the rule: standby is not work, another unit's shift is, and exempt employment types get
 * nothing.
 */

import { fromDayNumber } from '../../../domain/time.js';
import { asParams } from '../../../rules/registry.js';
import {
  judgesRun,
  judgesRunsOf,
  type ShortWorkRunsParams,
  shortWorkRunsRule,
} from '../../../rules/short-work-runs.js';
import { type Expr, expr, scale, sum } from '../builder.js';
import { describe, type EncodeContext, type TimelineEntry } from '../context.js';

/** One in-period entry of a candidate run: `pattern + x − (L + 2)`, 1 exactly when both hold. */
export interface RunPart {
  e: Expr;
  /** The entry is locked (a constant), so the part stands or falls with the days alone. */
  fixed: boolean;
  label: string;
}

/** One candidate short run of one nurse: its finding is "any part ≥ 1". */
export interface RunParts {
  /** Its first day, as a day number. */
  start: number;
  length: number;
  parts: RunPart[];
}

/**
 * The candidate short runs of nurse `n` and their parts. Shared so the hard encoder and the price
 * cannot disagree on which runs are judged or what a day worked is.
 */
export function shortWorkRunParts(
  ctx: EncodeContext,
  n: number,
  params: ShortWorkRunsParams,
): RunParts[] {
  if (!judgesRunsOf(ctx.model.nurses[n]!, params)) return [];
  const { period } = ctx.input;
  const span = {
    start: period.startDate,
    end: period.endDate,
    // The same reading of the history as the gate's rule context, so both judge alike.
    historyFrom: ctx.model.ctx.historyFrom,
  };
  const byDay = new Map<number, TimelineEntry[]>();
  for (const e of ctx.timeline(n)) {
    if (e.shiftType.isOnCall) continue;
    const list = byDay.get(e.day);
    if (list) list.push(e);
    else byDay.set(e.day, [e]);
  }
  const inPeriodDays = [...byDay]
    .filter(([, entries]) => entries.some((e) => e.inPeriod))
    .map(([day]) => day);
  if (inPeriodDays.length === 0) return [];
  const firstIn = Math.min(...inPeriodDays);
  const lastIn = Math.max(...inPeriodDays);
  const worked = (d: number): Expr => dayExpr(byDay.get(d));
  const name = ctx.name(n);

  const out: RunParts[] = [];
  for (let length = 1; length < params.minConsecutiveDays; length++) {
    for (let s = firstIn - length + 1; s <= lastIn; s++) {
      const end = s + length - 1;
      if (!judgesRun(s, end, span)) continue;
      const xs: TimelineEntry[] = [];
      for (let d = s; d <= end; d++) {
        for (const e of byDay.get(d) ?? []) if (e.inPeriod) xs.push(e);
      }
      if (xs.length === 0) continue;
      const before = worked(s - 1);
      const after = worked(end + 1);
      if (isConstant(before, 1) || isConstant(after, 1)) continue;
      const days: Expr[] = [];
      for (let d = s; d <= end; d++) days.push(worked(d));
      if (days.some((day) => isConstant(day, 0))) continue;
      const pattern = sum(expr([], 2), scale(before, -1), ...days, scale(after, -1));
      out.push({
        start: s,
        length,
        parts: xs.map((x) => ({
          e: sum(pattern, lit(x), expr([], -(length + 2))),
          fixed: x.literal === null,
          label:
            `short work run: ${name} ${fromDayNumber(s)} ` +
            `(${length} day${length === 1 ? '' : 's'}, ${describe(x)})`,
        })),
      });
    }
  }
  return out;
}

/** Whether day d is worked: 1 when a constant works it, else the sum of its variables. */
function dayExpr(entries: readonly TimelineEntry[] | undefined): Expr {
  if (!entries) return expr();
  if (entries.some((x) => x.literal === null)) return expr([], 1);
  return expr(entries.map((x) => [x.literal!, 1]));
}

function isConstant(e: Expr, value: number): boolean {
  return e.terms.length === 0 && e.constant === value;
}

function lit(x: TimelineEntry): Expr {
  return x.literal === null ? expr([], 1) : expr([[x.literal, 1]]);
}

export function encodeShortWorkRuns(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(shortWorkRunsRule, raw);
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    for (const { parts } of shortWorkRunParts(ctx, n, params)) {
      for (const part of parts) if (!part.fixed) ctx.b.atMost(part.e, 0, part.label);
    }
  }
}
