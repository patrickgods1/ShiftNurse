/**
 * `orientee-with-preceptor` for CP-SAT. A shift-scope hard rule, so — like the coverage floor —
 * it is priced, not forbidden: each orientee on a shift with none of their preceptors on it, or
 * on the shift it runs inside, costs `hardShortfall`, exactly as `SolverModel.coveragePenalty`
 * counts the rule's violations. Only shifts CP-SAT can change are priced here; the rest are
 * constants the annealer's model already priced (`coverageTerms`), and only shifts with demand,
 * which are the shifts the model judges.
 */

import { preceptorsOn } from '../../../rules/preceptor.js';
import { expr, scale, sum } from '../builder.js';
import type { EncodeContext } from '../context.js';
import { coverExpr, isMovable, staffedExpr } from './coverage.js';

export function encodePreceptor(ctx: EncodeContext): void {
  const { model } = ctx;
  if (model.ctx.preceptorshipsByOrientee.size === 0) return;
  const cost = ctx.weights.hardShortfall;
  for (const shift of model.shifts) {
    // Standby is not worked time, so the rule does not judge it (`isWorked`).
    if (!shift.demand || shift.shiftType.isOnCall || !isMovable(ctx, shift)) continue;
    // Each orientee who could be on this shift: a variable, or a locked row.
    const orientees = new Set<number>();
    for (const sv of ctx.byShift[shift.idx]!) orientees.add(sv.n);
    for (const a of ctx.lockedByShift[shift.idx]!) orientees.add(model.nurseOf(a));
    for (const n of orientees) {
      const preceptors = new Set(preceptorsOn(model.ctx, model.nurses[n]!.id, shift.date));
      if (preceptors.size === 0) continue;
      const isPreceptor = (m: number) => preceptors.has(model.nurses[m]!.id);
      const here = staffedExpr(ctx, shift, (m) => m === n);
      const present = sum(staffedExpr(ctx, shift, isPreceptor), coverExpr(ctx, shift, isPreceptor));
      const label = `orientee without preceptor: ${ctx.name(n)} ${shift.shiftType.abbreviation} ${shift.date}`;
      // The orientee is on the shift at most once, so here − present, floored at 0, is 1 exactly
      // when they work it and no preceptor does, however many preceptors are there.
      ctx.b.minimise(expr([[ctx.b.positivePart(sum(here, scale(present, -1)), label), 1]]), cost);
    }
  }
}
