/**
 * `no-overlapping-assignments` and `min-rest-between-shifts` as pairwise constraints.
 *
 * Overlap is pairwise in the rule too: every overlapping pair is one finding, so forbidding every
 * overlapping pair is exact.
 *
 * Rest is judged by the rule from the shift the nurse last stopped working: for C, the shifts
 * that started before it and end last (`latestEndingBefore`). A pair (A, C) is therefore the
 * rule's pair exactly when no worked shift B ends after A and starts before C. Plain "forbid
 * every close pair" is not enough, because a closer B does not always make A–C a breach the rule
 * would see: a waiver on B's date lets a night → day turnaround stand, and B then excuses the
 * longer after-night rest that A → C alone would be owed (36 hours after a night, A → C 24 hours,
 * B → C a plain 12). So each close pair is forbidden only while every such B is off:
 * `x_A + x_C − Σ x_B ≤ 1`. A worked B has its own clause against C. A constant B excuses the
 * pair outright, which is the same clause with B fixed to 1. The between set is strict on both
 * ends, so how the sort breaks ties cannot change it. This is the same argument as
 * `long-stretch`'s follower clause.
 *
 * With `callBackCountsForRest`, a call-back is a constant preceding shift whose end is the
 * call-back's: for C, the rule takes the call-back that started before C and ended last, and
 * measures from it only when no worked shift starting before C ends at or after it. So C is
 * forbidden while every such shift is off: `x_C − Σ x_B ≤ 0`, and a constant B skips it.
 */

import type { CallBack } from '../../../domain/entities.js';
import { overlapRule } from '../../../rules/availability-rules.js';
import { asParams } from '../../../rules/registry.js';
import { minRestRule, restWaivedOn } from '../../../rules/rest-rules.js';
import { isNightTour } from '../../../rules/tour-rotation.js';
import { expr } from '../builder.js';
import { describe, type EncodeContext, forbidPair } from '../context.js';

export function encodeOverlap(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(overlapRule, raw);
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
  const params = asParams(minRestRule, raw);
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const timeline = ctx
      .timeline(n)
      .filter((e) => params.onCallCountsAsWork || !e.shiftType.isOnCall);
    for (let i = 0; i < timeline.length; i++) {
      const a = timeline[i]!;
      const requiredHours =
        isNightTour(a.shiftType) && params.minRestHoursAfterNight !== undefined
          ? params.minRestHoursAfterNight
          : params.minRestHours;
      const required = requiredHours * 60;
      for (let j = i + 1; j < timeline.length; j++) {
        const c = timeline[j]!;
        const gap = c.window.startMinute - a.window.endMinute;
        // Gaps only grow along the sorted timeline.
        if (gap >= required) break;
        if (gap < 0) continue; // an overlap: the overlap rule's business
        // The nurse waived this turnaround in writing, for the shift that starts on c's date.
        if (restWaivedOn(ctx.model.ctx, ctx.model.nurses[n]!.id, c.date)) continue;
        // From the same filtered timeline, so standby never excuses a pair, as the rule ignores it.
        const between = timeline.filter(
          (b) =>
            b !== a &&
            b !== c &&
            b.window.endMinute > a.window.endMinute &&
            b.window.startMinute < c.window.startMinute,
        );
        // A worked shift between them: the rule measures from it instead.
        if (between.some((b) => b.literal === null)) continue;
        const e = expr();
        for (const entry of [a, c]) {
          if (entry.literal === null) e.constant += 1;
          else e.terms.push([entry.literal, 1]);
        }
        for (const b of between) e.terms.push([b.literal!, -1]);
        ctx.b.atMost(
          e,
          1,
          `rest: ${ctx.name(n)} ${describe(a)} → ${describe(c)} (${gap / 60}h, ${requiredHours}h required)`,
        );
      }
    }
    if (!params.callBackCountsForRest) continue;
    const nurseId = ctx.model.nurses[n]!.id;
    const callBacks = ctx.model.ctx.callBacksByNurse.get(nurseId) ?? [];
    if (callBacks.length === 0) continue;
    const required = params.minRestHours * 60;
    for (const c of timeline) {
      // The call-back C follows, as the rule picks it: started before C, ended last.
      let cb: CallBack | undefined;
      for (const x of callBacks) {
        if (x.window.startMinute >= c.window.startMinute) break;
        if (!cb || x.window.endMinute > cb.window.endMinute) cb = x;
      }
      if (!cb) continue;
      const gap = c.window.startMinute - cb.window.endMinute;
      if (gap < 0 || gap >= required) continue;
      if (restWaivedOn(ctx.model.ctx, nurseId, c.date)) continue;
      const end = cb.window.endMinute;
      // A worked shift that started before C and ended no earlier: the rule measures from it.
      const between = timeline.filter(
        (b) => b !== c && b.window.startMinute < c.window.startMinute && b.window.endMinute >= end,
      );
      if (between.some((b) => b.literal === null)) continue;
      const e = expr();
      if (c.literal === null) e.constant += 1;
      else e.terms.push([c.literal, 1]);
      for (const b of between) e.terms.push([b.literal!, -1]);
      ctx.b.atMost(
        e,
        0,
        `rest: ${ctx.name(n)} call-back to minute ${end} → ${describe(c)} (${gap / 60}h, ${params.minRestHours}h required)`,
      );
    }
  }
}
