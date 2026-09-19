/**
 * The conflict contract — what a staffing problem looks like as data, and what a ranked way
 * out of it looks like.
 *
 * ## Why this exists
 *
 * The solver's guarantee is "every nurse's timeline is legal; every shortfall is named". That
 * leaves the manager holding a list of shortfalls with no way out but trial and error on the
 * grid. A conflict is a shortfall (or a looming one — a cluster of pending PTO on one weekend)
 * with its cause attached; a resolution is one concrete change that closes it, *simulated*
 * for what it does to coverage, fairness and dollars before anyone commits to it. Without
 * the simulation the manager either picks the first nurse who says yes (and pays overtime or
 * hands the fourth weekend in a row to the same person) or over-approves PTO and finds out on
 * the day.
 *
 * ## Why the input is `SolveInput`
 *
 * Detection and resolution must judge a period by exactly the machinery the solver and the
 * grid use — same rule-set snapshot, same derived demand, same lookback tail, same pay
 * context — or a resolution can look legal here and turn a cell red on the grid. Reusing the
 * plain-data `SolveInput` guarantees that, and means the desktop's `buildSolveInput` serves
 * both. A what-if (approve this request, deny that one) is a *copy* of the input with the
 * request's status changed; nothing here mutates its arguments.
 *
 * ## Determinism
 *
 * Conflict and resolution ids are derived from their content, never from a counter or the
 * clock, so re-running detection on unchanged inputs yields identical ids — the renderer keys
 * cards on them and the audit log quotes them.
 */

import type { Assignment, Budget, Id, NurseRole, TimeOffRequest } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import type { Violation } from '../rules/types.js';
import type { ObjectiveWeights, SolveInput } from '../solver/types.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ConflictInput extends SolveInput {
  /** The period's budget, when set; without it no budget conflict can be raised. */
  budget?: Budget;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * - `understaffing`: a role on a shift is below its coverage-floor minimum.
 * - `ratio_breach`: a role on a shift is below the patient-ratio minimum (the legal one).
 * - `competing_time_off`: approving every *pending* request touching a date would (or already
 *   does, counting approved ones) push a shift below its hard minimum — visible before the
 *   manager approves the one that tips it.
 * - `fte`: a nurse is short of contracted hours for the period, or over the weekly maximum.
 * - `credential`: a shift lacks a required credential, or an assigned nurse's credential
 *   expires before the shift.
 * - `budget`: the priced schedule exceeds the period budget.
 * - `scheduled_on_leave`: a nurse is rostered during leave that is already approved — leave
 *   approved after the draft was built, or a locked assignment the approval could not lift.
 */
export type ConflictKind =
  | 'understaffing'
  | 'ratio_breach'
  | 'competing_time_off'
  | 'fte'
  | 'credential'
  | 'budget'
  | 'scheduled_on_leave';

export type ConflictSeverity = 'hard' | 'soft';

export interface Conflict {
  /** Content-derived, stable across runs on the same inputs. */
  id: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  /** Every date the conflict touches; a single-shift conflict has exactly one. */
  dates: IsoDate[];
  shiftTypeId?: Id;
  role?: NurseRole;
  nurseIds: Id[];
  /** Requests implicated — the competing PTO, or the approved leave that emptied a shift. */
  timeOffIds: Id[];
  /** Written for a nurse manager, naming names and numbers. */
  message: string;
  /**
   * How bad, in one comparable unit: nurse-slots short for staffing kinds, hours for `fte`,
   * dollars over for `budget`, 1 per missing credential. Used to order the conflict list.
   */
  magnitude: number;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Resolutions
// ---------------------------------------------------------------------------

/**
 * - `assign_available`: give the shift to a nurse who is legal for it at straight time.
 * - `authorize_overtime`: give it to a nurse for whom it is overtime, flagged as authorised.
 * - `move_assignment`: move a nurse off a shift that is above target onto the short one.
 * - `deny_time_off`: deny a *pending* request whose nurse could then cover the shift.
 * - `remove_assignment`: take a nurse off a shift they should not hold (rostered on approved
 *   leave) without a replacement, leaving it short on the record.
 * - `accept_shortfall`: leave it short, on the record, so it appears as a deliberate decision.
 */
export type ResolutionKind =
  | 'assign_available'
  | 'authorize_overtime'
  | 'move_assignment'
  | 'deny_time_off'
  | 'remove_assignment'
  | 'accept_shortfall';

/** Plain data the caller persists inside one transaction; core never writes anything. */
export type ResolutionAction =
  | {
      type: 'create_assignment';
      nurseId: Id;
      shiftTypeId: Id;
      date: IsoDate;
      isCharge: boolean;
      isOvertime: boolean;
    }
  | { type: 'move_assignment'; assignmentId: Id; toDate: IsoDate; toShiftTypeId: Id }
  | { type: 'delete_assignment'; assignmentId: Id }
  | { type: 'deny_time_off'; timeOffId: Id }
  | { type: 'accept_shortfall'; conflictId: string };

export interface CoverageImpact {
  /** Nurse-slots below a hard minimum across the whole period. */
  hardShortfallBefore: number;
  hardShortfallAfter: number;
  /** Negative is better. */
  delta: number;
}

export interface FairnessImpact {
  /** Unit mean of the per-nurse composite, 0–100. */
  unitScoreBefore: number;
  unitScoreAfter: number;
  /** Positive is better. */
  delta: number;
  /** Only nurses whose composite actually moved. */
  affected: { nurseId: Id; before: number; after: number }[];
}

export interface CostImpact {
  dollarsBefore: number;
  dollarsAfter: number;
  /** Positive costs money. */
  delta: number;
  /** True when a nurse involved has no resolvable rate, so the delta is a lower bound. */
  unpriced: boolean;
}

export interface ResolutionImpact {
  coverage: CoverageImpact;
  fairness: FairnessImpact;
  cost: CostImpact;
  /** Soft violations the change introduces. A resolution that introduces a hard one is never emitted. */
  softViolationsIntroduced: Violation[];
  /** Soft violations the change clears. */
  softViolationsCleared: Violation[];
}

export interface Resolution {
  /** Content-derived, stable across runs on the same inputs. */
  id: string;
  conflictId: string;
  kind: ResolutionKind;
  /** One line for the card header, e.g. "Assign Priya Nair (RN) — straight time". */
  title: string;
  /** Two or three sentences a manager can read aloud to justify the choice. */
  description: string;
  actions: ResolutionAction[];
  impact: ResolutionImpact;
  /**
   * Higher is better. Coverage closed dominates, then fairness, then dollars, using the same
   * `ObjectiveWeights` the solver ranks candidates by so the two never disagree about which
   * of two nurses is the better pick.
   */
  score: number;
  /** The nurses this change touches, for the card and for the audit entry. */
  nurseIds: Id[];
  /**
   * True when the simulated change removes its conflict entirely — the cell reaches its hard
   * minimum, the credential is covered — as opposed to closing one of several slots. What
   * auto-resolve requires before it will act.
   */
  closesConflict?: boolean;
}

// ---------------------------------------------------------------------------
// Report & policy
// ---------------------------------------------------------------------------

export interface ConflictSummary {
  hard: number;
  soft: number;
  byKind: Record<ConflictKind, number>;
  /** Total nurse-slots short of a hard minimum across the period. */
  hardShortfall: number;
}

export interface ConflictReport {
  periodId: Id;
  /** Worst first: hard before soft, then by magnitude, then by date. */
  conflicts: Conflict[];
  /** Every conflict's options, best first within a conflict. */
  resolutions: Resolution[];
  summary: ConflictSummary;
}

/**
 * Auto-resolve ships **off**. When on, only a resolution that closes its conflict fully,
 * costs no more than `maxCostDelta`, drops the unit fairness score by no more than
 * `maxFairnessDrop` points and introduces no soft violation qualifies — and the caller still
 * writes an `auto_resolve` audit entry quoting the resolution's description as its reason.
 */
export interface AutoResolvePolicy {
  enabled: boolean;
  maxCostDelta: number;
  maxFairnessDrop: number;
}

export const DEFAULT_AUTO_RESOLVE_POLICY: AutoResolvePolicy = {
  enabled: false,
  maxCostDelta: 0,
  maxFairnessDrop: 1,
};

export interface ResolutionOptions {
  /** Cap per conflict; the best `n` by score. Default 5. */
  maxPerConflict?: number;
  /** Overrides for the ranking weights; defaults to the solver's. */
  weights?: Partial<ObjectiveWeights>;
}

// ---------------------------------------------------------------------------
// Time-off what-if
// ---------------------------------------------------------------------------

/** What approving (or denying) one request would do to the period, before deciding. */
export interface TimeOffImpact {
  request: TimeOffRequest;
  decision: 'approved' | 'denied';
  /** Conflicts present after the decision that were not present before. */
  introduced: Conflict[];
  /** Conflicts present before that the decision clears. */
  cleared: Conflict[];
  /** The nurse's own assignments inside the requested range that the decision would orphan. */
  displacedAssignments: Assignment[];
  coverage: CoverageImpact;
  /** Other pending requests overlapping the same dates — the competition the manager is judging. */
  competing: TimeOffRequest[];
}
