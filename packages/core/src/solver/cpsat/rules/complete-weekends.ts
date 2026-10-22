/**
 * `complete-weekends` for CP-SAT, when a rule set makes it hard (while soft it is priced instead,
 * one Boolean per nurse and weekend, by `completeWeekendTerms` in `objective.ts`, from the same
 * `completeWeekendParts`).
 *
 * The rule's breach is "some in-period shift filed under the weekend is worked, and some day of
 * it has no worked shift dated on it". Every shift dated on a weekend day is filed under that
 * weekend, so it is written per pair of such a shift `x` and a day `d` as `x − Σ dated(d)`, which
 * is 1 exactly when `x` is worked and `d` is not. A day a locked or lookback shift already works
 * makes no pair; a variable dated on the day itself cannot be worked with the day off, so its own
 * day makes none either. Hard, each pair whose shift is a variable is held at ≤ 0: a variable
 * filed under the weekend brings every day of it with it. A pair whose shift is locked is left
 * out — that is a pinned breach, left to stand (all off stays feasible, as `atMost` treats a
 * standing violation), while every variable that would join it must still complete the weekend,
 * which is exactly what the gate tolerates (a breach naming only pinned shifts).
 *
 * As in the rule: only own-unit worked shifts (`worksWeekendHere`), only weekends this schedule
 * works, whose days all fall on or before its last and none before the complete history
 * (`judgedWeekends`), and no Baylor nurse.
 */

import { type IsoDate, weekendKey } from '../../../domain/time.js';
import { judgedWeekends, worksWeekendHere } from '../../../rules/complete-weekends.js';
import { judgesWeekends } from '../../../rules/weekend-pattern.js';
import { type Expr, expr, scale, sum } from '../builder.js';
import { countExpr, describe, type EncodeContext, type TimelineEntry } from '../context.js';

/** One pair: `x − Σ dated(d)`, ≥ 1 exactly when shift `x` is worked and day `d` is not. */
export interface SplitPart {
  e: Expr;
  /** The shift is locked (a constant), so the pair stands or falls with the day alone. */
  fixed: boolean;
  label: string;
}

/** One judged weekend of one nurse: its breach is "any part ≥ 1". */
export interface WeekendParts {
  weekend: IsoDate;
  parts: SplitPart[];
}

/**
 * The judged weekends of nurse `n` and their pairs. Shared so the hard encoder and the price
 * cannot disagree on which weekends are judged or what a day worked is.
 */
export function completeWeekendParts(ctx: EncodeContext, n: number): WeekendParts[] {
  if (!judgesWeekends(ctx.model.nurses[n]!)) return [];
  const { ruleSet, period } = ctx.input;
  const def = ruleSet.weekendDefinition;
  const timeline = ctx.timeline(n).filter(worksWeekendHere);
  const name = ctx.name(n);
  const out: WeekendParts[] = [];
  for (const { weekend, dates } of judgedWeekends(timeline, def, {
    start: period.startDate,
    end: period.endDate,
    // The same reading of the history as the gate's rule context, so both judge alike.
    historyFrom: ctx.model.ctx.historyFrom,
  })) {
    const keyed = timeline.filter((e) => e.inPeriod && weekendKey(e.window, def) === weekend);
    const parts: SplitPart[] = [];
    for (const d of dates) {
      const dated = timeline.filter((e) => e.date === d);
      if (dated.some((e) => e.literal === null)) continue;
      const day = countExpr(dated);
      for (const x of keyed) {
        if (x.literal !== null && dated.includes(x)) continue;
        parts.push({
          e: sum(lit(x), scale(day, -1)),
          fixed: x.literal === null,
          label: `complete weekend: ${name} ${weekend} (${describe(x)}, off ${d})`,
        });
      }
    }
    if (parts.length > 0) out.push({ weekend, parts });
  }
  return out;
}

function lit(x: TimelineEntry): Expr {
  return x.literal === null ? expr([], 1) : expr([[x.literal, 1]]);
}

export function encodeCompleteWeekends(ctx: EncodeContext, _raw: Record<string, unknown>): void {
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    for (const { parts } of completeWeekendParts(ctx, n)) {
      for (const part of parts) if (!part.fixed) ctx.b.atMost(part.e, 0, part.label);
    }
  }
}
