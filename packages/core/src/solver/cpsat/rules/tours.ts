/**
 * `tour-rotation` for CP-SAT, when a rule set makes it hard (while soft it is not priced, so
 * Generate ignores it and the grid flags it).
 *
 * Three constraints, one per violation code. A shift off the nurse's permanent tour is forbidden
 * outright. Two worked shifts on different tours closer than the break are a forbidden pair, as
 * the rest rule's are: a shift between them is on one of their tours and so at least as close to
 * the other, which the rule would flag — no legal schedule is lost. And a nurse's distinct
 * in-period tours are counted with one Boolean per tour ("any shift of this tour is worked")
 * summed against the cap; a locked shift makes its tour's Boolean a constant.
 */

import { TOURS } from '../../../domain/entities.js';
import { asParams } from '../../../rules/registry.js';
import { tourOf, tourRotationRule } from '../../../rules/tour-rotation.js';
import { type Expr, expr, sum } from '../builder.js';
import { describe, type EncodeContext, forbidPair } from '../context.js';

export function encodeTourRotation(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(tourRotationRule, raw);
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const nurse = ctx.model.nurses[n]!;
    const timeline = ctx.timeline(n).filter((e) => !e.shiftType.isOnCall);

    if (nurse.permanentTour && params.permanentTourEnforced) {
      for (const e of timeline) {
        // A constant off its tour is a standing breach the manager pinned; leave it be.
        if (!e.inPeriod || e.literal === null || tourOf(e.shiftType) === nurse.permanentTour) {
          continue;
        }
        ctx.b.linear(
          expr([[e.literal, 1]]),
          0,
          0,
          `permanent tour: ${ctx.name(n)} is ${nurse.permanentTour}, not ${describe(e)}`,
        );
      }
    }

    const required = params.minHoursBetweenTours * 60;
    for (let i = 0; i < timeline.length; i++) {
      const a = timeline[i]!;
      const aTour = tourOf(a.shiftType);
      for (let j = i + 1; j < timeline.length; j++) {
        const b = timeline[j]!;
        const gap = b.window.startMinute - a.window.endMinute;
        // Gaps only grow along the sorted timeline.
        if (gap >= required) break;
        if (gap < 0) continue; // an overlap: the overlap rule's business
        if (tourOf(b.shiftType) === aTour) continue;
        forbidPair(
          ctx,
          a,
          b,
          `tour change: ${ctx.name(n)} ${describe(a)} → ${describe(b)} (${gap / 60}h, ${params.minHoursBetweenTours}h required)`,
        );
      }
    }

    const used: Expr[] = [];
    for (const tour of TOURS) {
      const entries = timeline.filter((e) => e.inPeriod && tourOf(e.shiftType) === tour);
      if (entries.length === 0) continue;
      if (entries.some((e) => e.literal === null)) used.push(expr([], 1));
      else {
        const label = `tour used: ${ctx.name(n)} ${tour}`;
        used.push(
          entries.length === 1
            ? expr([[entries[0]!.literal!, 1]])
            : expr([
                [
                  ctx.b.exactOr(
                    entries.map((e) => e.literal!),
                    label,
                  ),
                  1,
                ],
              ]),
        );
      }
    }
    if (used.length > params.maxToursPerPeriod) {
      ctx.b.atMost(sum(...used), params.maxToursPerPeriod, `tours per schedule: ${ctx.name(n)}`);
    }
  }
}
