/**
 * `avoid-pending-time-off` when a rule set makes it hard: no worked shift inside a pending
 * request. Constants (locked shifts, the lookback tail) are left as the gate leaves them — a
 * baseline, not something to forbid. While the rule is soft it forbids nothing and is priced per
 * shift instead (`SolverModel.pendingPenaltyOf`, in `perShiftTerms`).
 */

import { pendingRequestOn } from '../../../rules/pending-time-off.js';
import { expr } from '../builder.js';
import type { EncodeContext } from '../context.js';

export function encodePendingTimeOff(ctx: EncodeContext): void {
  for (const sv of ctx.shiftVars) {
    if (sv.shift.shiftType.isOnCall) continue;
    if (!pendingRequestOn(ctx.model.ctx, sv.nurseId, sv.shift.date)) continue;
    ctx.b.linear(
      expr([[sv.variable, 1]]),
      0,
      0,
      `pending time off: ${ctx.name(sv.n)} ${sv.shift.date}`,
    );
  }
}
