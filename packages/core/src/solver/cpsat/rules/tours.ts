/**
 * `tour-rotation` for CP-SAT, when a rule set makes it hard (while soft it is priced instead, per
 * finding, by `tourRotationTerms` in `objective.ts`).
 *
 * Three constraints, one per violation code. A shift off the nurse's permanent tour is forbidden
 * outright. Two worked shifts on different tours closer than the break are a forbidden pair. The
 * rule measures from the shift that ends last before each one, but a schedule it accepts never
 * violates such a pair (there is one break length and no waiver, so a shift between can never
 * excuse one): if B sits between A and C and ends after A, then either B overlaps one of them
 * (the hard overlap rule's business) or B's tour differs from C's or from A's with a gap smaller
 * than A → C's, so the rule flags a pair itself. The pairs are therefore exact on legality, and
 * stricter only when the overlap rule is off. And a nurse's distinct in-period tours are counted
 * with one Boolean per tour ("any shift of this tour is worked") summed against the cap; a locked
 * shift makes its tour's Boolean a constant. The cap and the permanent-tour switch are per nurse,
 * from `effectiveTourLimits`, so a career nurse exempt from rotation is held to one tour here
 * exactly as the rule holds them — and, as there, a tour she asked for (`requestedTours`) is left
 * out of both the count and the permanent-tour forbids.
 */

import { TOURS } from '../../../domain/entities.js';
import { asParams } from '../../../rules/registry.js';
import {
  type EffectiveTourLimits,
  effectiveTourLimits,
  requestedTours,
  tourOf,
  tourRotationRule,
} from '../../../rules/tour-rotation.js';
import { type Expr, expr, sum } from '../builder.js';
import { describe, type EncodeContext, forbidPair, type TimelineEntry } from '../context.js';

export function encodeTourRotation(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(tourRotationRule, raw);
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const nurse = ctx.model.nurses[n]!;
    const timeline = ctx.timeline(n).filter((e) => !e.shiftType.isOnCall);
    const limits = effectiveTourLimits(
      nurse,
      params,
      ctx.input.period.startDate,
      requestedTours(nurse.id, ctx.model.ctx),
    );

    if (nurse.permanentTour && limits.permanentTourEnforced) {
      for (const e of timeline) {
        // A constant off its tour is a standing breach the manager pinned; leave it be.
        const tour = tourOf(e.shiftType);
        if (
          !e.inPeriod ||
          e.literal === null ||
          tour === nurse.permanentTour ||
          limits.requested.has(tour)
        ) {
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

    const used = toursUsed(ctx, n, timeline, limits);
    if (used.length > limits.maxToursPerPeriod) {
      ctx.b.atMost(sum(...used), limits.maxToursPerPeriod, `tours per schedule: ${ctx.name(n)}`);
    }
  }
}

/**
 * One expression per tour the schedule chose for this nurse in the period — 1 when any of its
 * shifts is worked: a constant when one is locked, else a shift's own variable or their Boolean
 * or. Tours she asked for are left out, as the rule leaves them out of the count. Shared by the
 * hard cap here and the soft price in `objective.ts`, so both count tours the same way.
 */
export function toursUsed(
  ctx: EncodeContext,
  n: number,
  timeline: readonly TimelineEntry[],
  limits: EffectiveTourLimits,
): Expr[] {
  const used: Expr[] = [];
  for (const tour of TOURS) {
    if (limits.requested.has(tour)) continue;
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
  return used;
}
