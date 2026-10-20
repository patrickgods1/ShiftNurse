/**
 * `long-stretch` for CP-SAT, when a rule set makes it hard (while soft it is not priced, so
 * Generate ignores it and the grid flags it — the same stated limit as `max-hours-in-24`).
 *
 * `requiredOnly` adds nothing: it judges a mandated holdover or overtime nobody volunteered for,
 * and no row either solver writes is one (decoded answers are straight time and a draft carries no
 * holdover), so a generated schedule cannot breach it — as for `no-mandatory-overtime`.
 *
 * Otherwise every shift counts, and the rule's stretch is a run of shifts each starting at or
 * before the previous one's end, or at most `maxBreakMinutesInStretch` (b, absent 0) after it; its
 * length is the minutes worked, the union of its windows, so a bridged break is not counted. The
 * encoding forbids chains instead of reifying stretches:
 *
 * - a chain of such shifts whose worked minutes pass the cap may not be worked in full — Σ x ≤ len − 1,
 *   locked shifts and the lookback tail folded in as constants. Whatever else is worked beside the
 *   chain only lengthens the real stretch, so the cap needs no side conditions, except that a
 *   locked shift noted "Emergency:" touching the chain excuses it when the rule says so;
 * - a chain that earns rest (worked ≥ or > the threshold) followed by a shift starting more than b
 *   and less than `restHours` after its end may not be worked in full (a shift within b joins the
 *   stretch rather than following it) — but only when no *other* shift could
 *   lengthen that stretch or start before the follower (it ends after the chain and starts before
 *   the follower), so the clause is Σ chain + follower − Σ those ≤ len. Without it a chain worked
 *   together with an overlapping shift that carries the stretch on would be forbidden although the
 *   rule measures the rest from the later end. A follower the waiver excuses is skipped, keyed on
 *   its own date as the rule keys it, and an emergency never skips a rest pair.
 *
 * Chains are built backwards from their last shift, each earlier one ending inside the one after
 * it or at most b before its start (and before its end, so a shift inside the span, an 8 inside a
 * 12, changes neither the hours nor the end and is left out), and stop as soon as the worked
 * minutes pass the limit: the real stretch contains such a tail with the same end, so nothing is
 * lost, and the count stays small however long a run of shifts could be. Worked minutes grow
 * with the chain: putting `p` in front of `first` adds `min(p.end, first.start) − p.start`, the
 * part of `p` before the chain began. Anything else worked beside a chain can only add worked
 * minutes (it covers more of the clock or fills a break), so the side-condition-free cap clause
 * still holds. With b = 0 a chain has no gaps and its worked minutes are its span, as before. A chain or pair of constants alone is left alone, as `forbidPair`
 * leaves two constants alone, so a locked or historical breach cannot make the model infeasible.
 * A locked shift between a chain and its follower skips the rest clause (it could start the next
 * stretch itself): conservative, never forbidding what the rule allows, and the rule engine still
 * judges it after decode. An emergency excuses a chain only when a locked shift noted "Emergency:"
 * touches its span or sits within the bridge of it, as the rule would join it; one joined to it only
 * through other shifts is not seen, which is stricter, never illegal.
 *
 * Hours are hours worked: on the DST nights the real minutes (`schedule/real-minutes.ts`, D19),
 * the window itself on the wall clock. A chain's worked minutes are the real minutes of its parts,
 * as `workedStretches` counts them for the rule; its end, the bridge and the rest gap stay wall.
 *
 * Not monotone under removal (dropping the middle of a stretch can leave a long first part
 * followed too soon by the last); `SolverModel.isLegal` re-checks every enabled nurse-scope hard
 * rule for a nurse who lost a shift, which covers this one, and CP-SAT's answers go back through
 * `SolverModel.canAdd` before anything is written.
 */

import { MINUTES_PER_HOUR } from '../../../domain/time.js';
import { longStretchRule } from '../../../rules/long-stretch.js';
import { isEmergency } from '../../../rules/mandatory-overtime.js';
import { asParams } from '../../../rules/registry.js';
import { restWaivedOn } from '../../../rules/rest-rules.js';
import { realMinutesIn } from '../../../schedule/real-minutes.js';
import { expr } from '../builder.js';
import { describe, type EncodeContext, type TimelineEntry } from '../context.js';

export function encodeLongStretch(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = asParams(longStretchRule, raw);
  if (params.requiredOnly) return;
  const capMinutes =
    params.maxConsecutiveHours === undefined
      ? undefined
      : Math.floor(params.maxConsecutiveHours * MINUTES_PER_HOUR + 1e-6);
  const thresholdMinutes =
    params.restAfterHours === undefined
      ? undefined
      : Math.round(params.restAfterHours * MINUTES_PER_HOUR);
  if (capMinutes === undefined && thresholdMinutes === undefined) return;
  const restMinutes = Math.round(params.restHours * MINUTES_PER_HOUR);
  const bridge = params.maxBreakMinutesInStretch ?? 0;
  const tz = ctx.model.ctx.dstTransitions;

  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const entries = ctx.timeline(n).filter((e) => !e.shiftType.isOnCall);
    const nurseId = ctx.model.nurses[n]!.id;
    const emergencies = entries.filter(
      (e) => e.literal === null && e.assignment !== null && isEmergency(e.assignment),
    );

    // Chains ending at `last`, grown backwards until `reached(worked)`; each is reported once.
    const grow = (
      chain: TimelineEntry[],
      end: number,
      worked: number,
      reached: (worked: number) => boolean,
      report: (chain: TimelineEntry[], end: number) => void,
    ) => {
      const first = chain[0]!;
      if (reached(worked)) {
        report(chain, end);
        return;
      }
      for (const p of entries) {
        if (p.window.startMinute >= first.window.startMinute) break;
        // The one before `first` ends inside it or within the bridge before it, and before it
        // ends (or it adds nothing).
        if (p === first || p.window.endMinute + bridge < first.window.startMinute) continue;
        if (p.window.endMinute >= first.window.endMinute) continue;
        const added = realMinutesIn(
          {
            startMinute: p.window.startMinute,
            endMinute: Math.min(p.window.endMinute, first.window.startMinute),
          },
          tz,
        );
        grow([p, ...chain], end, worked + added, reached, report);
      }
    };

    const forbidChain = (chain: TimelineEntry[], end: number) => {
      const start = chain[0]!.window.startMinute;
      if (
        params.emergencyLiftsCap &&
        // Within the bridge of the chain's span is in its stretch for the rule too.
        emergencies.some(
          (e) => e.window.startMinute <= end + bridge && e.window.endMinute + bridge >= start,
        )
      ) {
        return;
      }
      const e = expr();
      for (const entry of chain) {
        if (entry.literal === null) e.constant += 1;
        else e.terms.push([entry.literal, 1]);
      }
      ctx.b.atMost(
        e,
        chain.length - 1,
        `long stretch: ${ctx.name(n)} ${chain.map(describe).join(' + ')}`,
      );
    };

    const forbidEarlyFollowers = (chain: TimelineEntry[], end: number) => {
      for (const b of entries) {
        const gap = b.window.startMinute - end;
        // Within the bridge it joins the stretch: not a follower.
        if (gap <= bridge) continue;
        // Sorted by start: the gap only grows from here.
        if (gap >= restMinutes) break;
        if (params.honorsRestWaiver && restWaivedOn(ctx.model.ctx, nurseId, b.date)) continue;
        const others = entries.filter(
          (o) =>
            !chain.includes(o) &&
            o !== b &&
            o.window.endMinute > end &&
            o.window.startMinute < b.window.startMinute,
        );
        if (others.some((o) => o.literal === null)) continue;
        const e = expr();
        for (const entry of [...chain, b]) {
          if (entry.literal === null) e.constant += 1;
          else e.terms.push([entry.literal, 1]);
        }
        for (const o of others) e.terms.push([o.literal!, -1]);
        ctx.b.atMost(
          e,
          chain.length,
          `rest after long stretch: ${ctx.name(n)} ${chain.map(describe).join(' + ')} → ${describe(b)} (${gap / 60}h off, ${params.restHours}h required)`,
        );
      }
    };

    for (const last of entries) {
      const end = last.window.endMinute;
      const own = realMinutesIn(last.window, tz);
      if (capMinutes !== undefined) {
        grow([last], end, own, (worked) => worked > capMinutes, forbidChain);
      }
      if (thresholdMinutes !== undefined) {
        const reached = (worked: number) =>
          params.restOnlyPastThreshold ? worked > thresholdMinutes : worked >= thresholdMinutes;
        grow([last], end, own, reached, forbidEarlyFollowers);
      }
    }
  }
}
