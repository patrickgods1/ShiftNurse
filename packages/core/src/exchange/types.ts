/**
 * The shift-exchange contract — a trade or giveaway as data, and the verdict on it.
 *
 * ## Why this exists
 *
 * An exchange is the one edit a manager makes *at a nurse's request*, and it is where the
 * quiet rule breaks happen: the swap that looks harmless on the grid turns a Friday night into
 * a Saturday day with six hours' rest, or hands a fourth weekend in a row to the nurse who
 * already carries the most. So every exchange is judged by the same rule engine, fairness
 * scorer and cost engine as the grid — against a *copy* of the schedule with the exchange
 * applied — and the verdict names the rule when it blocks and shows the before/after when it
 * merely warns. The decision policy is fixed by the roadmap: a hard-rule breach blocks and
 * cannot be overridden; a soft-rule or fairness impact warns and can be approved with a
 * reason the audit log keeps.
 *
 * ## Why evaluation takes `ConflictInput`
 *
 * Same reason the conflict detector does: an exchange must be judged by the period's own
 * rule-set snapshot, derived demand, lookback tail and pay context, or it can pass here and
 * turn a cell red on the grid. `ExchangeInput` is that plain-data bundle plus the proposal.
 *
 * ## Vocabulary
 *
 * - **trade**: nurse A gives assignment X to nurse B and takes assignment Y from B. Both
 *   assignments change hands; the shifts themselves stay staffed at the same headcount.
 * - **giveaway**: nurse A gives assignment X to nurse B and takes nothing back. Hours move from
 *   A to B, so FTE floors, the overtime threshold and the price of the pickup are what matter.
 */

import type { ConflictInput, CostImpact, FairnessImpact } from '../conflicts/types.js';
import type { Assignment, Id, RequestOrigin, Timestamp } from '../domain/entities.js';
import type { Violation } from '../rules/types.js';

// ---------------------------------------------------------------------------
// The entity
// ---------------------------------------------------------------------------

export type ShiftSwapKind = 'trade' | 'giveaway';

/**
 * `proposed` → `approved` | `denied` | `cancelled`. An approved swap has already been applied
 * to the grid in the same transaction; there is no separate "applied" state to drift.
 */
export type ShiftSwapStatus = 'proposed' | 'approved' | 'denied' | 'cancelled';

export interface ShiftSwap {
  id: Id;
  periodId: Id;
  kind: ShiftSwapKind;
  /** The nurse giving up `offeredAssignmentId`. */
  requestingNurseId: Id;
  /** The nurse receiving it (and, in a trade, giving up `requestedAssignmentId`). */
  counterpartyNurseId: Id;
  offeredAssignmentId: Id;
  /** Present for a trade, absent for a giveaway. */
  requestedAssignmentId?: Id;
  status: ShiftSwapStatus;
  /** Always `'manager'` in v1. See `RequestOrigin`. */
  enteredBy: RequestOrigin;
  submittedAt: Timestamp;
  decidedAt?: Timestamp;
  decidedBy?: string;
  /** The nurses' stated reason, if given. */
  reason?: string;
  /** Required on denial and on an approval that overrides a warning. */
  decisionReason?: string;
  /** True when the approval went ahead despite warnings; the reason says why. */
  overrode?: boolean;
}

// ---------------------------------------------------------------------------
// Proposal & evaluation
// ---------------------------------------------------------------------------

export interface ExchangeProposal {
  kind: ShiftSwapKind;
  requestingNurseId: Id;
  counterpartyNurseId: Id;
  offeredAssignmentId: Id;
  requestedAssignmentId?: Id;
}

export interface ExchangeInput extends ConflictInput {
  proposal: ExchangeProposal;
}

/** One nurse's side of the exchange, so the UI can show each column. */
export interface NurseSideImpact {
  nurseId: Id;
  /** Hours in the period before and after; a giveaway moves these. */
  hoursBefore: number;
  hoursAfter: number;
  /** Per-nurse fairness composite, 0–100. */
  fairnessBefore: number;
  fairnessAfter: number;
  /** Period cost attributable to this nurse. */
  dollarsBefore: number;
  dollarsAfter: number;
  /** Hard violations the exchange would introduce on this nurse's timeline. Any → blocked. */
  hardViolations: Violation[];
  softViolationsIntroduced: Violation[];
  softViolationsCleared: Violation[];
}

/**
 * - `ok`: no hard breach, no warning; approve freely.
 * - `warn`: legal, but a soft rule fires or fairness/cost moves against the unit; approval
 *   needs a reason.
 * - `blocked`: a hard rule breaks on either side or a shift would drop below its hard minimum;
 *   cannot be approved.
 */
export type ExchangeVerdict = 'ok' | 'warn' | 'blocked';

export interface ExchangeEvaluation {
  verdict: ExchangeVerdict;
  /** Why it is blocked, one line per hard breach, naming the rule and the nurse. Empty unless blocked. */
  blockers: string[];
  /** Why it warns, one line each. Empty when `ok`. */
  warnings: string[];
  requesting: NurseSideImpact;
  counterparty: NurseSideImpact;
  /** Unit-level, same shapes the resolution cards use. */
  fairness: FairnessImpact;
  cost: CostImpact;
  /** Shift-scope hard violations introduced (a shift losing its only charge nurse, a credential). */
  shiftViolationsIntroduced: Violation[];
  /** The assignments as they would exist after the exchange, for the preview grid. */
  after: Assignment[];
}

/** The rows the caller writes when an exchange is approved. Plain data; core writes nothing. */
export interface ExchangeApplication {
  /** Assignments to delete, by id. */
  remove: Id[];
  /** Assignments to create, carrying charge/OT/notes across from the originals. */
  create: Omit<Assignment, 'id'>[];
}
