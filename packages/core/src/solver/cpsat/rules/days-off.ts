/**
 * `days-off-together` for CP-SAT, when a rule set makes it hard (while soft it is not priced, so
 * Generate ignores it and the grid flags it).
 *
 * Per nurse and complete pay period: a Boolean `all` that every weekend of it is worked
 * (`Σ worked − all ≤ |K| − 1` forces it to 1 when they all are; a constant 1 when locked shifts
 * and the lookback tail already work them all), a Boolean per adjacent pair of its dates that may
 * be 1 only when neither date has a worked shift dated on it, and `Σ pair ≥ all`. A weekend the
 * nurse has no shift filed under is a constant 0, so the pay period asks nothing. A pinned
 * breach — every weekend fixed worked and no pair left that could be free — is left to stand
 * rather than make the model infeasible, as `atMost` treats a standing violation.
 */

import { addDays, compareDates, datesInRange, type IsoDate } from '../../../domain/time.js';
import { payPeriodWeekends } from '../../../rules/days-off-together.js';
import { type Expr, evalExpr, expr, scale, sum } from '../builder.js';
import type { EncodeContext } from '../context.js';
import { anyWorked, nurseWeekendExprs } from './weekends.js';

const isConstant = (e: Expr) => e.terms.length === 0;

export function encodeDaysOffTogether(ctx: EncodeContext, _raw: Record<string, unknown>): void {
  const { period, unit, ruleSet } = ctx.input;
  const payPeriods = payPeriodWeekends(
    { start: period.startDate, end: period.endDate },
    unit,
    ruleSet.weekendDefinition,
  );
  if (payPeriods.length === 0) return;

  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const name = ctx.name(n);
    const worked = nurseWeekendExprs(ctx, n).worked;
    const timeline = ctx.timeline(n).filter((e) => !e.shiftType.isOnCall);

    for (const pp of payPeriods) {
      const weekends = pp.weekends.map((w) => worked.get(w));
      if (weekends.some((e) => e === undefined)) continue;
      const label = `days off together: ${name} ${pp.start}`;

      let all: Expr;
      if (weekends.every((e) => isConstant(e!))) all = expr([], 1);
      else {
        const given = weekends.map((e) => e!);
        // Its value in a finished schedule, for `CpBuilder.evaluate`: the solver is free to set
        // it higher, never lower, than the constraint below allows.
        const every = ctx.b.auxiliary(`${label} every weekend`, 0, 1, (value) =>
          given.every((e) => evalExpr(e, value) === 1) ? 1 : 0,
        );
        all = expr([[every, 1]]);
        ctx.b.atMost(sum(...weekends.map((e) => e!), scale(all, -1)), weekends.length - 1, label);
      }

      const busy = new Map<IsoDate, Expr>();
      for (const date of datesInRange(pp.start, pp.end)) {
        const dated = timeline.filter((e) => e.date === date);
        busy.set(
          date,
          dated.length === 0 ? expr([], 0) : anyWorked(ctx, dated, `busy: ${name} ${date}`),
        );
      }

      const pairs: Expr[] = [];
      let freePair = false;
      for (let d = pp.start; compareDates(d, pp.end) < 0; d = addDays(d, 1)) {
        const here = busy.get(d)!;
        const next = busy.get(addDays(d, 1))!;
        // A locked shift on either day rules the pair out; two days with nothing to decide are a
        // pair already, and the pay period is satisfied whatever the rest does.
        if (here.constant > 0 || next.constant > 0) continue;
        if (isConstant(here) && isConstant(next)) {
          freePair = true;
          break;
        }
        const pair = ctx.b.auxiliary(`${label} off ${d} and the next day`, 0, 1, (value) =>
          evalExpr(here, value) === 0 && evalExpr(next, value) === 0 ? 1 : 0,
        );
        ctx.b.atMost(sum(expr([[pair, 1]]), here), 1, `${label} ${d} worked`);
        ctx.b.atMost(sum(expr([[pair, 1]]), next), 1, `${label} ${addDays(d, 1)} worked`);
        pairs.push(expr([[pair, 1]]));
      }
      if (freePair) continue;
      // Nothing the solver could free, under weekends already fixed: a standing breach.
      if (pairs.length === 0 && isConstant(all)) continue;
      ctx.b.linear(sum(...pairs, scale(all, -1)), 0, Number.POSITIVE_INFINITY, label);
    }
  }
}
