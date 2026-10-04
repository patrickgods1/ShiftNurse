/**
 * `recovery-after-nights` when a rule set makes it hard: every night and day-side shift too
 * close after it is a forbidden pair, as the rest rule's pairs are. While the rule is soft it
 * forbids nothing and is priced instead (`nightRecoveryTerms` in `objective.ts`).
 */

import {
  isDaySide,
  isWorkedNight,
  nightRecoveryRule,
  tooSoonAfterNight,
} from '../../../rules/night-recovery.js';
import { asParams } from '../../../rules/registry.js';
import { describe, type EncodeContext, forbidPair } from '../context.js';

export function encodeNightRecovery(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const required = Math.max(0, Math.floor(asParams(nightRecoveryRule, raw).daysOffAfterNights));
  if (required === 0) return;
  for (const [n, vars] of ctx.byNurse.entries()) {
    if (vars.length === 0) continue;
    const timeline = ctx.timeline(n);
    const nights = timeline.filter(isWorkedNight);
    for (const day of timeline) {
      if (!day.inPeriod || !isDaySide(day)) continue;
      for (const night of nights) {
        if (!tooSoonAfterNight(night.day, day.day, required)) continue;
        forbidPair(
          ctx,
          night,
          day,
          `recovery: ${ctx.name(n)} ${describe(night)} → ${describe(day)} (${required} days off)`,
        );
      }
    }
  }
}
