/**
 * The day-of contract — a call-off, the ranked search for someone to cover it, and the live
 * staffing check the Today screen runs against the census as it actually is.
 *
 * ## Why this exists
 *
 * A published schedule survives contact with the unit for about a week. Then someone calls in
 * sick at 05:40 and the charge nurse starts phoning people from memory: the ones who usually
 * say yes, which is how the same three nurses end up carrying every call-out and every hour
 * of overtime. The replacement finder replaces that memory with the rule engine — who is
 * *legal* for the shift right now (rest, consecutive limits, credentials, not already working,
 * not on leave) — and then orders the legal ones the way the contract says to: straight time
 * before overtime before agency, then who has carried the least, then who was called least
 * recently. The call log records every attempt so the next call-off starts from the facts.
 *
 * ## Why the input is `ConflictInput`
 *
 * Same reason exchanges take it: the shift must be judged by the period's own rule-set
 * snapshot, derived demand, lookback tail and pay context, or a replacement can look legal
 * here and turn a cell red on the grid. `ReplacementInput` is that bundle plus the absent
 * assignment and the recency of every nurse's last call.
 *
 * ## The ordering is lexicographic, on purpose
 *
 * `payTier`, then cost, then burden, then recency. A weighted blend would let a cheap agency
 * nurse outrank an idle staff nurse, which is exactly the decision a manager must never make
 * silently — the tiers are the contract's priority, the rest breaks ties within a tier.
 */

import type { BindingConstraint } from '../acuity/demand.js';
import type { ConflictInput, CostImpact } from '../conflicts/types.js';
import type { Assignment, Id, NurseRole, Timestamp } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import type { Violation } from '../rules/types.js';

// ---------------------------------------------------------------------------
// Replacement finder
// ---------------------------------------------------------------------------

/**
 * The contract's cost priority. `straight` is a staff nurse at their ordinary rate; `overtime`
 * is a staff nurse for whom this shift crosses the weekly threshold and is flagged authorised;
 * `agency` is any `employmentType: 'agency'` nurse, whatever the hour count.
 */
export type PayTier = 'straight' | 'overtime' | 'agency';

export const PAY_TIER_ORDER: readonly PayTier[] = ['straight', 'overtime', 'agency'];

export interface ReplacementInput extends ConflictInput {
  /** The in-period assignment the nurse called off from. */
  absentAssignmentId: Id;
  /**
   * When each nurse was last phoned about *any* call-off, epoch millis. A nurse with no entry
   * has never been called and sorts first within a tier — the finder spreads the calls.
   */
  lastCalledAt: Readonly<Record<Id, Timestamp>>;
}

export interface ReplacementCandidate {
  nurseId: Id;
  /** "Priya Nair (RN)" — what the call list prints. */
  label: string;
  phone?: string;
  payTier: PayTier;
  /**
   * The row a backfill writes: `source: 'callout'` so the fairness ledger counts it as a
   * call-out covered, `isOvertime` set only when that authorisation is what makes it legal.
   */
  assignment: Omit<Assignment, 'id'>;
  /** Marginal dollars of putting this nurse on the shift, priced over their whole timeline. */
  cost: CostImpact;
  /**
   * Signed burden index from fairness scoring (history plus this period). Negative means the
   * nurse has carried less than their fair share — the fairer pick, so lower sorts first.
   */
  burdenIndex: number;
  lastCalledAt?: Timestamp;
  /** Soft rules the pickup would trip; shown on the card, never a reason to exclude. */
  softViolationsIntroduced: Violation[];
  /** 1-based position after ordering. */
  rank: number;
}

export interface ExcludedNurse {
  nurseId: Id;
  label: string;
  /** One line for the "why isn't she on the list?" question: the rule name and its message. */
  reason: string;
}

export interface ReplacementReport {
  absent: { assignmentId: Id; nurseId: Id; date: IsoDate; shiftTypeId: Id; role: NurseRole };
  /** Nurse-slots this shift is short of its hard minimum for the absent nurse's role, with them gone. */
  shortfall: number;
  /** Ordered best-first; every entry is legal to write as-is. */
  candidates: ReplacementCandidate[];
  /** Same-role active nurses who were considered and ruled out, in nurse-id order. */
  excluded: ExcludedNurse[];
}

// ---------------------------------------------------------------------------
// Live staffing check
// ---------------------------------------------------------------------------

/**
 * Which census number a shift's requirement was derived from. `actual` once the manager has
 * entered the real count for the shift, `forecast` before that, `floor` when no census row
 * exists at all and only the static coverage floor applies.
 */
export type CensusBasis = 'actual' | 'forecast' | 'floor';

export interface RoleStaffing {
  role: NurseRole;
  /** Hard minimum for this role on this shift under the chosen census basis. */
  required: number;
  staffed: number;
  /** `max(0, required − staffed)`. */
  shortfall: number;
  bindingConstraint: BindingConstraint;
}

export interface ShiftStaffingCheck {
  date: IsoDate;
  shiftTypeId: Id;
  basis: CensusBasis;
  /** The census the check used (actual or projected); 0 under `floor`. */
  census: number;
  byRole: Record<NurseRole, RoleStaffing>;
  /** Any role short of its minimum. */
  short: boolean;
  /**
   * Any role short of a minimum that the patient ratio (not just the coverage floor) sets —
   * the legal breach, as opposed to the contractual one.
   */
  ratioBreached: boolean;
}

/** One shift on one calendar day — the night shift running at 03:00 is *yesterday's* slot. */
export interface ShiftSlot {
  date: IsoDate;
  shiftTypeId: Id;
}

export interface ShiftsAround {
  /** Every shift whose window contains the given minute; overlapping types (a D8 inside a D12) all count. */
  current: ShiftSlot[];
  /** The earliest shift starting strictly after the given minute, wrapping to tomorrow's first. */
  next: ShiftSlot | undefined;
}
