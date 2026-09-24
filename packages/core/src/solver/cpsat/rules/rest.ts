/**
 * `no-overlapping-assignments` and `min-rest-between-shifts` as pairwise exclusions.
 *
 * The rules compare each shift with the next one on the nurse's timeline; forbidding every
 * too-close *pair* is the same thing. If a shift B sits between A and C, B starts no earlier than
 * A and no later than C, so B is at least as close to A as C is — any A–C pair the rules would
 * see as neighbours is caught, and no legal schedule is excluded. (With the overlap rule switched
 * off, a pair straddling an overlap is still forbidden; that is stricter, never illegal.)
 */

import type { OverlapParams } from '../../../rules/availability-rules.js';
import type { MinRestParams } from '../../../rules/rest-rules.js';
import { describe, type EncodeContext, forbidPair } from '../context.js';

export function encodeOverlap(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = raw as unknown as OverlapParams;
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const timeline = ctx.timeline(n);
    for (let i = 0; i < timeline.length; i++) {
      const a = timeline[i]!;
      for (let j = i + 1; j < timeline.length; j++) {
        const b = timeline[j]!;
        // Sorted by start: once one starts after A ends, every later one does too.
        if (b.window.startMinute >= a.window.endMinute) break;
        if (params.allowOnCallDuringShift && (a.shiftType.isOnCall || b.shiftType.isOnCall)) {
          continue;
        }
        forbidPair(ctx, a, b, `overlap: ${ctx.name(n)} ${describe(a)} / ${describe(b)}`);
      }
    }
  }
}

export function encodeRest(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = raw as unknown as MinRestParams;
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const timeline = ctx
      .timeline(n)
      .filter((e) => params.onCallCountsAsWork || !e.shiftType.isOnCall);
    for (let i = 0; i < timeline.length; i++) {
      const a = timeline[i]!;
      const requiredHours =
        a.shiftType.isNight && params.minRestHoursAfterNight !== undefined
          ? params.minRestHoursAfterNight
          : params.minRestHours;
      const required = requiredHours * 60;
      for (let j = i + 1; j < timeline.length; j++) {
        const b = timeline[j]!;
        const gap = b.window.startMinute - a.window.endMinute;
        // Gaps only grow along the sorted timeline.
        if (gap >= required) break;
        if (gap < 0) continue; // an overlap: the overlap rule's business
        forbidPair(
          ctx,
          a,
          b,
          `rest: ${ctx.name(n)} ${describe(a)} → ${describe(b)} (${gap / 60}h, ${requiredHours}h required)`,
        );
      }
    }
  }
}
