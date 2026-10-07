/**
 * `schedule-kind-tours` for CP-SAT: every variable that would put a 72/80 or Baylor nurse on a
 * shift off their plan is fixed to 0. A variable is never overtime (neither solver writes an
 * overtime row), so the rule's overtime exception never applies to one.
 *
 * The verdict is the rule's own `offPlanTour`, asked of the view the shift would have — its
 * declared length and scheduled window, which is all a draft shift carries — so the encoder and
 * the rule cannot drift apart on what a Baylor tour is. A locked off-plan shift is a constant and
 * a standing breach the manager pinned; it is left be, as `encodeTourRotation` leaves one.
 */

import { isBaylorPlan } from '../../../cost/cost.js';
import { offPlanTour } from '../../../rules/schedule-kind-tours.js';
import type { AssignmentView } from '../../../schedule/view.js';
import { expr } from '../builder.js';
import { describe, type EncodeContext, type TimelineEntry } from '../context.js';

function candidateView(ctx: EncodeContext, n: number, e: TimelineEntry): AssignmentView {
  const nurse = ctx.model.nurses[n]!;
  return {
    assignment: {
      id: `cpsat-${nurse.id}-${e.date}-${e.shiftType.id}`,
      periodId: ctx.input.period.id,
      nurseId: nurse.id,
      shiftTypeId: e.shiftType.id,
      date: e.date,
      source: 'solver',
      isLocked: false,
      isCharge: false,
      isOvertime: false,
    },
    nurse,
    shiftType: e.shiftType,
    window: e.window,
    paidHours: e.shiftType.durationHours,
    scheduledHours: e.shiftType.durationHours,
    inPeriod: true,
  };
}

export function encodeScheduleKindTours(ctx: EncodeContext, _raw: Record<string, unknown>): void {
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const nurse = ctx.model.nurses[n]!;
    if (nurse.scheduleKind !== 'va_72_80' && !isBaylorPlan(nurse)) continue;
    for (const e of ctx.timeline(n)) {
      if (!e.inPeriod || e.literal === null || e.shiftType.isOnCall) continue;
      if (!offPlanTour(candidateView(ctx, n, e))) continue;
      ctx.b.linear(expr([[e.literal, 1]]), 0, 0, `off plan: ${ctx.name(n)} ${describe(e)}`);
    }
  }
}
