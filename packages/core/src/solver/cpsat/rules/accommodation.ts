/**
 * `accommodation-blocks`: no variable whose shift overlaps one of its nurse's blocks may be 1.
 * Like a hard pending request, a constant (a locked shift, the lookback tail) is left as the gate
 * leaves it: a baseline, not something to forbid. The overlap question is the rule's own
 * `blockedAt`, so the solver and the grid cannot disagree about a window.
 */

import { shiftWindow } from '../../../domain/time.js';
import { accommodationBlocksRule, blockedAt } from '../../../rules/availability-blocks.js';
import { asParams } from '../../../rules/registry.js';
import { expr } from '../builder.js';
import type { EncodeContext } from '../context.js';

export function encodeAccommodationBlocks(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(accommodationBlocksRule, raw);
  for (const sv of ctx.shiftVars) {
    if (sv.shift.shiftType.isOnCall && !params.onCallCounts) continue;
    const window = shiftWindow(sv.shift.date, sv.shift.shiftType);
    if (!blockedAt(ctx.model.ctx, sv.nurseId, window, sv.shift.date)) continue;
    ctx.b.linear(
      expr([[sv.variable, 1]]),
      0,
      0,
      `accommodation: ${ctx.name(sv.n)} ${sv.shift.date}`,
    );
  }
}
