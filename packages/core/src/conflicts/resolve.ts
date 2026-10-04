/**
 * Resolution generation — every concrete way out of a conflict, simulated and ranked.
 *
 * ## Why every candidate is simulated
 *
 * "Priya is free Saturday night" is not the same as "Priya may work Saturday night": she may
 * be on a day shift Sunday morning (no rest), on her fourth night in a row, or at 40 hours for
 * the week. And an option that is legal can still be a bad idea — it may be the fourth weekend
 * in a row for the same person, or $300 dearer than the next name. So each candidate is applied
 * to a copy of the schedule and measured through the same engine the grid uses: rule violations
 * introduced and cleared, slots still short, the unit fairness score, and dollars. Nothing here
 * predicts what a rule would say; it asks the rule.
 *
 * ## The gate
 *
 * A candidate that introduces a hard violation is never emitted — the same standard the solver
 * holds itself to. Two hard codes are exempt from that test because they are the thing being
 * measured rather than a side effect: `under_contracted_hours` (a floor every nurse starts
 * below, pushed toward by the objective) and the two coverage codes (`understaffed`,
 * `ratio_breach`), which `CoverageImpact` prices in slots.
 *
 * ## Overtime
 *
 * The weekly-hours rule (`hours-rules.ts`) raises `unauthorised_overtime` for a week past the
 * overtime threshold with no assignment flagged as authorised, and `over_max_hours` for a week
 * past the absolute cap regardless of authorisation. So a nurse whose only objection is the
 * former is offered as `authorize_overtime` with `isOvertime: true`, which the rule accepts;
 * one past the cap is dropped, because no flag makes that legal.
 *
 * ## Ranking
 *
 * `score` uses the solver's `ObjectiveWeights` so the two never disagree about which of two
 * nurses is the better pick (see `scoreResolution` for the exact formula). Within a conflict the
 * options are best first and `accept_shortfall` is always last — it is the option of record,
 * not a recommendation.
 */

import type { Id } from '../domain/entities.js';
import { DEFAULT_OBJECTIVE_WEIGHTS, type ObjectiveWeights } from '../solver/types.js';
import { competingOptions, leaveOptions, slotOptions } from './candidates.js';
import { ConflictEngine, type SimState } from './engine.js';
import { dayLabel, plural } from './text.js';
import type { Conflict, ConflictInput, Resolution, ResolutionOptions } from './types.js';

// Re-exported so the barrel keeps `scoreResolution` where callers have always found it.
export { scoreResolution } from './resolution-score.js';

const DEFAULT_MAX_PER_CONFLICT = 5;

/** Generate ranked resolutions for every conflict. Pure: the input is never mutated. */
export function generateResolutions(
  input: ConflictInput,
  conflicts: readonly Conflict[],
  options: ResolutionOptions = {},
): Resolution[] {
  return resolveWith(new ConflictEngine(input), conflicts, options);
}

/** Resolution on an existing engine, so analysis shares its indexes with detection. */
export function resolveWith(
  engine: ConflictEngine,
  conflicts: readonly Conflict[],
  options: ResolutionOptions = {},
): Resolution[] {
  const weights: ObjectiveWeights = { ...DEFAULT_OBJECTIVE_WEIGHTS, ...options.weights };
  const max = Math.max(1, options.maxPerConflict ?? DEFAULT_MAX_PER_CONFLICT);
  const baseline = engine.baseline();
  const out: Resolution[] = [];

  for (const conflict of conflicts) {
    let candidates: Resolution[] = [];
    switch (conflict.kind) {
      case 'understaffing':
      case 'ratio_breach':
        candidates = slotOptions(engine, baseline, conflict, weights, {
          role: conflict.role ?? null,
          credentialId: null,
        });
        break;
      case 'credential':
        if (conflict.details.kind === 'missing' && conflict.shiftTypeId) {
          candidates = slotOptions(engine, baseline, conflict, weights, {
            role: conflict.role ?? null,
            credentialId: String(conflict.details.credentialId) as Id,
          });
        }
        break;
      case 'competing_time_off':
        candidates = competingOptions(engine, baseline, conflict, weights);
        break;
      case 'scheduled_on_leave':
        candidates = leaveOptions(engine, baseline, conflict, weights, max);
        break;
      case 'fte':
      case 'budget':
        break;
    }
    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    // The cap counts the shortfall option: `max` cards per conflict, the last one always it.
    out.push(...candidates.slice(0, max - 1), acceptShortfall(baseline, conflict));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Accept the shortfall
// ---------------------------------------------------------------------------

function acceptShortfall(base: SimState, conflict: Conflict): Resolution {
  const shortfall = base.hardShortfall();
  const fairness = base.fairness();
  const total = base.costTotal();
  const what =
    conflict.kind === 'budget'
      ? 'the budget overrun'
      : conflict.kind === 'fte'
        ? 'the hours discrepancy'
        : `${conflict.dates[0] ? `${dayLabel(conflict.dates[0])} ` : ''}${plural(conflict.magnitude, 'slot')} short`;
  return {
    id: `${conflict.id}/accept_shortfall`,
    conflictId: conflict.id,
    kind: 'accept_shortfall',
    title: 'Accept the shortfall',
    description: `Leaves ${what} as it is, recorded as a deliberate decision with your reason.`,
    actions: [{ type: 'accept_shortfall', conflictId: conflict.id }],
    impact: {
      coverage: { hardShortfallBefore: shortfall, hardShortfallAfter: shortfall, delta: 0 },
      fairness: {
        unitScoreBefore: fairness.mean,
        unitScoreAfter: fairness.mean,
        delta: 0,
        affected: [],
      },
      cost: { dollarsBefore: total, dollarsAfter: total, delta: 0, unpriced: !base.engine.costCtx },
      softViolationsIntroduced: [],
      softViolationsCleared: [],
    },
    score: 0,
    nurseIds: [],
    closesConflict: false,
  };
}
