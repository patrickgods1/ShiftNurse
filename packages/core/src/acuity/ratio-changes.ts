/**
 * Which edits to a patient-ratio ceiling need a stated reason, and the words that name them.
 *
 * A ratio ceiling is what gets quoted if staffing on a shift is challenged, so loosening one has
 * to leave more on the record than "someone changed it". Switching off the ratio *rule* already
 * needs a reason (`protectedRuleChanges`), but the ceiling table underneath it did not: a 1:4
 * on High acuity, cited "CA Title 22 §70217", could become 1:6 with the citation cleared and
 * the audit log would hold no why. Tightening needs no reason — nobody grieves a safer ratio —
 * and neither does adding a citation where there was none.
 *
 * The comparison and the message live here, pure, so the repository refuses with exactly the
 * words the editor shows before Save, and the two cannot drift.
 */

import type { Id, RatioRole, RatioRule, Tour } from '../domain/entities.js';

/** One kind of protected edit; `protectedRatioChanges` lists them in this order, each once. */
export type RatioChange =
  | 'raised'
  | 'rn-share-lowered'
  | 'role'
  | 'tier'
  | 'tour'
  | 're-cited'
  | 'deactivated';

function hasCitation(rule: RatioRule): rule is RatioRule & { citation: string } {
  return rule.citation !== undefined && rule.citation.trim() !== '';
}

/**
 * The edits from `before` to `after` that loosen, move or retire the ceiling. A role, tier or tour
 * change is protected in both directions: it moves the ceiling onto different staff, patients or
 * shifts, and judging whether that is looser would need the unit's whole rule table.
 */
export function protectedRatioChanges(before: RatioRule, after: RatioRule): RatioChange[] {
  const changes: RatioChange[] = [];
  if (after.maxPatientsPerNurse > before.maxPatientsPerNurse) changes.push('raised');
  if (
    before.minRnShare !== undefined &&
    (after.minRnShare === undefined || after.minRnShare < before.minRnShare)
  ) {
    changes.push('rn-share-lowered');
  }
  if (after.role !== before.role) changes.push('role');
  if (after.acuityTierId !== before.acuityTierId) changes.push('tier');
  if (after.tour !== before.tour) changes.push('tour');
  if (hasCitation(before) && after.citation !== before.citation) changes.push('re-cited');
  if (before.active && !after.active) changes.push('deactivated');
  return changes;
}

const ROLE_LABEL: Record<RatioRole, string> = {
  RN: 'RN',
  LPN: 'LPN',
  CNA: 'CNA',
  licensed: 'licensed-nurse',
};

function ratioRoleLabel(role: RatioRole): string {
  return ROLE_LABEL[role];
}

function tierLabel(tierId: Id | null, tierNames: Readonly<Record<Id, string>>): string {
  if (tierId === null) return 'every tier';
  // A tier cannot be deleted while a rule cites it, so a miss is a stale list, not an id to show.
  return tierNames[tierId] ?? 'an unknown tier';
}

function tourLabel(tour: Tour | undefined): string {
  return tour === undefined ? 'every shift' : `${tour} shifts`;
}

/**
 * "RN ratio on High", "CNA ratio on every tier on night shifts": how a refusal names a ratio rule,
 * shared with the repository's deactivation refusal so both read the same.
 */
export function ratioRuleSubject(rule: RatioRule, tierNames: Readonly<Record<Id, string>>): string {
  const subject = `${ratioRoleLabel(rule.role)} ratio on ${tierLabel(rule.acuityTierId, tierNames)}`;
  return rule.tour === undefined ? subject : `${subject} on ${tourLabel(rule.tour)}`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * "Changing the RN ratio on High (ceiling 1:4 → 1:6, citation removed)": the subject of the
 * refusal and of the editor's reason prompt. `onTier` names the tier the rule had *before* the
 * edit, since that is the ceiling being changed.
 *
 * Takes `after` as well as `before`: every part but `deactivated` prints the new value.
 * `tierNames` maps tier id to name (`null`, all tiers, needs no entry), so core stays free of the
 * database. Signature: `describeRatioChanges(before, after, changes, tierNames)`.
 */
export function describeRatioChanges(
  before: RatioRule,
  after: RatioRule,
  changes: readonly RatioChange[],
  tierNames: Readonly<Record<Id, string>>,
): string {
  const parts: string[] = [];
  for (const change of changes) {
    switch (change) {
      case 'raised':
        parts.push(`ceiling 1:${before.maxPatientsPerNurse} → 1:${after.maxPatientsPerNurse}`);
        break;
      case 'rn-share-lowered':
        parts.push(
          `RN share ${pct(before.minRnShare ?? 0)} → ${after.minRnShare === undefined ? 'none' : pct(after.minRnShare)}`,
        );
        break;
      case 'role':
        parts.push(`role ${ratioRoleLabel(before.role)} → ${ratioRoleLabel(after.role)}`);
        break;
      case 'tier':
        parts.push(
          `tier ${tierLabel(before.acuityTierId, tierNames)} → ${tierLabel(after.acuityTierId, tierNames)}`,
        );
        break;
      case 'tour':
        parts.push(`tour ${tourLabel(before.tour)} → ${tourLabel(after.tour)}`);
        break;
      case 're-cited':
        parts.push(hasCitation(after) ? 'citation changed' : 'citation removed');
        break;
      case 'deactivated':
        parts.push('deactivated');
        break;
    }
  }
  return `Changing the ${ratioRuleSubject(before, tierNames)} (${parts.join(', ')})`;
}
