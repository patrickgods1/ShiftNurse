/**
 * `weekend-pattern` for CP-SAT. A weekend is "worked" when any worked (not standby) shift on its
 * timeline falls in it, as `weekendKey` files shifts; the expressions here are 0/1 and are built
 * once per nurse for both the soft price (`weekendPatternTerms` in `objective.ts`) and the hard
 * encoder below. Counted as `weekendBreaches` counts: an in-period weekend breaches the run limit
 * when it and the `max` weekends before it were all worked — so `positivePart(sum − max)` over
 * those `max + 1` weekends is exactly one breach — and each in-period weekend over the
 * per-schedule limit is another.
 *
 * The four-week window is anchored only at a worked in-period weekend W, so its expression must
 * be at most zero whenever W is off: `5·here + Σ before − limit − 4`, with `before` the three
 * earlier weekends on the timeline. Worked, it is `1 + Σ before − limit`, the window's excess;
 * off, it is at most `3 − limit − 4`, negative for any limit.
 */

import type { IsoDate } from '../../../domain/time.js';
import { addDays, compareDates, weekendKey } from '../../../domain/time.js';
import { asParams } from '../../../rules/registry.js';
import {
  judgesWeekends,
  type WeekendPatternParams,
  weekendPatternRule,
} from '../../../rules/weekend-pattern.js';
import { type Expr, expr, scale, sum } from '../builder.js';
import type { EncodeContext, TimelineEntry } from '../context.js';

export interface NurseWeekendExprs {
  /** 1 when the weekend is worked at all, lookback tail included. */
  worked: ReadonlyMap<IsoDate, Expr>;
  /** 1 when the weekend is worked inside the period; only weekends the period can touch. */
  inPeriod: ReadonlyMap<IsoDate, Expr>;
}

/** 1 when any entry is worked: a constant if one is fixed, else the Boolean or of the rest. */
export function anyWorked(
  ctx: EncodeContext,
  entries: readonly TimelineEntry[],
  label: string,
): Expr {
  if (entries.some((e) => e.literal === null)) return expr([], 1);
  if (entries.length === 1) return expr([[entries[0]!.literal!, 1]]);
  return expr([
    [
      ctx.b.exactOr(
        entries.map((e) => e.literal!),
        label,
      ),
      1,
    ],
  ]);
}

export function nurseWeekendExprs(ctx: EncodeContext, n: number): NurseWeekendExprs {
  const def = ctx.input.ruleSet.weekendDefinition;
  const all = new Map<IsoDate, TimelineEntry[]>();
  const inPeriodEntries = new Map<IsoDate, TimelineEntry[]>();
  for (const entry of ctx.timeline(n)) {
    if (entry.shiftType.isOnCall) continue;
    const key = weekendKey(entry.window, def) as IsoDate | null;
    if (key === null) continue;
    all.set(key, [...(all.get(key) ?? []), entry]);
    if (entry.inPeriod) inPeriodEntries.set(key, [...(inPeriodEntries.get(key) ?? []), entry]);
  }
  const name = ctx.name(n);
  const worked = new Map<IsoDate, Expr>();
  for (const [key, entries] of all) {
    worked.set(key, anyWorked(ctx, entries, `weekend: ${name} ${key}`));
  }
  const inPeriod = new Map<IsoDate, Expr>();
  for (const [key, entries] of inPeriodEntries) {
    // Same expression when every entry of the weekend is in the period: no second variable.
    inPeriod.set(
      key,
      entries.length === all.get(key)!.length
        ? worked.get(key)!
        : anyWorked(ctx, entries, `weekend in period: ${name} ${key}`),
    );
  }
  return { worked, inPeriod };
}

/**
 * The expressions whose positive part is one breach each: `run − max` for every in-period weekend
 * that could end too long a run, and `weekends − limit` for the schedule. A run needs all `max`
 * weekends before it on the timeline; one missing anywhere means no run can end there. Each
 * in-period weekend also ends a four-week window when that limit is set; a weekend off the
 * timeline simply adds nothing to it.
 */
export function weekendBreachExprs(
  weekends: NurseWeekendExprs,
  params: WeekendPatternParams,
): {
  runs: { weekend: IsoDate; over: Expr }[];
  excess: Expr | null;
  windows: { weekend: IsoDate; over: Expr }[];
} {
  const max = Math.max(0, Math.floor(params.maxConsecutiveWeekends));
  const perFour = params.maxWeekendsPer4Weeks;
  const runs: { weekend: IsoDate; over: Expr }[] = [];
  const windows: { weekend: IsoDate; over: Expr }[] = [];
  for (const [weekend, here] of [...weekends.inPeriod].sort(([a], [b]) => compareDates(a, b))) {
    if (perFour !== undefined) {
      const earlier: Expr[] = [];
      for (let back = 1; back < 4; back++) {
        const e = weekends.worked.get(addDays(weekend, -7 * back));
        if (e) earlier.push(e);
      }
      windows.push({
        weekend,
        over: sum(scale(here, 5), ...earlier, expr([], -Math.floor(perFour) - 4)),
      });
    }
    const before: Expr[] = [];
    for (let back = 1; back <= max; back++) {
      const e = weekends.worked.get(addDays(weekend, -7 * back));
      if (!e) break;
      before.push(e);
    }
    if (before.length < max) continue;
    runs.push({ weekend, over: sum(here, ...before, expr([], -max)) });
  }
  const limit = params.maxWeekendsPerPeriod;
  const excess =
    limit === undefined || weekends.inPeriod.size === 0
      ? null
      : sum(...weekends.inPeriod.values(), expr([], -Math.floor(limit)));
  return { runs, excess, windows };
}

/**
 * Hard: no run past the limit, no more weekends in the schedule than allowed, and none past the
 * limit in any four weeks. A Baylor nurse is not judged (`judgesWeekends`).
 */
export function encodeWeekendPattern(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(weekendPatternRule, raw);
  for (let n = 0; n < ctx.model.nurses.length; n++) {
    if ((ctx.byNurse[n] ?? []).length === 0 || !judgesWeekends(ctx.model.nurses[n]!)) continue;
    const { runs, excess, windows } = weekendBreachExprs(nurseWeekendExprs(ctx, n), params);
    for (const { weekend, over } of runs) {
      ctx.b.atMost(over, 0, `weekends in a row: ${ctx.name(n)} to ${weekend}`);
    }
    for (const { weekend, over } of windows) {
      ctx.b.atMost(over, 0, `weekends in any four weeks: ${ctx.name(n)} to ${weekend}`);
    }
    if (excess) ctx.b.atMost(excess, 0, `weekends per schedule: ${ctx.name(n)}`);
  }
}
