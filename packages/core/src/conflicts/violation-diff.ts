/**
 * Identity and diffing for violations across two simulated schedules.
 *
 * Resolution scoring and exchange evaluation ask the same question — "did this change
 * introduce or clear a violation?" — by comparing two violation lists keyed on identity rather
 * than object reference (a violation recomputed from scratch on a copied schedule is never
 * `===` the original even when nothing about it changed). Shared here so the two callers never
 * drift on what "the same violation" means, which would let one silently miss an introduced
 * hard rule the other catches.
 */

import { getRule } from '../rules/registry.js';
import type { Violation } from '../rules/types.js';

/**
 * Identity of a violation across two schedules. A shift-scope violation lists its whole roster
 * in `nurseIds`, so it is keyed by the shift and role instead — otherwise adding one nurse
 * would make a still-missing charge nurse read as both cleared and introduced.
 */
export function violationKey(v: Violation): string {
  const d = v.details ?? {};
  const who =
    getRule(v.ruleId)?.scope === 'shift'
      ? `${d.shiftTypeId ?? ''}|${d.role ?? ''}|${d.credentialId ?? ''}`
      : [...v.nurseIds].sort().join(',');
  return `${v.ruleId}|${v.code}|${v.dates.join(',')}|${who}`;
}

/** Violations present after but not before ("introduced") and before but not after ("cleared"). */
export function diffViolations(
  before: readonly Violation[],
  after: readonly Violation[],
): { introduced: Violation[]; cleared: Violation[] } {
  const wasThere = new Map(before.map((v) => [violationKey(v), v]));
  const isThere = new Map(after.map((v) => [violationKey(v), v]));
  const introduced = [...isThere.entries()].filter(([k]) => !wasThere.has(k)).map(([, v]) => v);
  const cleared = [...wasThere.entries()].filter(([k]) => !isThere.has(k)).map(([, v]) => v);
  return { introduced, cleared };
}
