/**
 * The rule engine's vocabulary.
 *
 * Rules are **data plus a small evaluator**, held in a registry, rather than logic baked
 * into the solver. A new union clause is a new registry entry and a parameter row — the
 * solver, the schedule grid and the pre-publish report all pick it up without modification.
 *
 * The same engine drives four things, which is why `evaluate` takes a whole `ScheduleView`
 * rather than a single assignment:
 *
 * 1. Solver feasibility — is this candidate schedule legal?
 * 2. Live validation — what turns red as the manager drags a shift?
 * 3. The pre-publish compliance report.
 * 4. Day-of replacement eligibility — can this nurse legally take this call-off?
 *
 * `hard` violations make a schedule illegal; the solver will not emit one. `soft` violations
 * are advisory warnings the manager may knowingly accept. Scoring pressure — "this is legal
 * but unfair" — lives in the objective functions, not here, so that warnings and preferences
 * never get conflated.
 */

import type { DemandTable } from '../acuity/demand.js';
import type {
  Credential,
  Holiday,
  Id,
  Nurse,
  NurseCredential,
  ShiftCredentialRequirement,
  ShiftType,
  TimeOffRequest,
  Unit,
} from '../domain/entities.js';
import type { IsoDate, WeekendDefinition } from '../domain/time.js';
import type { FairnessWeights } from '../fairness/types.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';

export type RuleSeverity = 'hard' | 'soft';

/**
 * What a rule's verdict depends on. The solver evaluates rules incrementally — one nurse's
 * timeline after a candidate shift is added, or one shift's roster after it changes — and
 * can only do that if every rule declares which of the two it reads:
 *
 * - `nurse`: the verdict for a nurse follows from that nurse's own timeline alone (rest,
 *   consecutive shifts, hours, leave, double-booking). Evaluating it on a view holding only
 *   that nurse gives the same answer as the full schedule.
 * - `shift`: the verdict for a shift follows from who is on that shift (floors, ratios,
 *   charge, skill mix, credentials). Evaluating it on a view holding only that date and
 *   shift type gives the same answer as the full schedule.
 *
 * A rule that needed both at once could not be checked incrementally and would have to be
 * priced by the solver as a full-schedule penalty; none of the shipped rules do.
 */
export type RuleScope = 'nurse' | 'shift';

/** Machine-readable violation categories, so the UI can group and route them. */
export type ViolationCode =
  | 'insufficient_rest'
  | 'too_many_consecutive_shifts'
  | 'too_many_consecutive_nights'
  | 'missing_required_days_off'
  | 'over_max_hours'
  | 'unauthorised_overtime'
  | 'under_contracted_hours'
  | 'over_contracted_hours'
  | 'understaffed'
  | 'missing_charge_nurse'
  | 'missing_credential'
  | 'expired_credential'
  | 'all_novice_shift'
  | 'ratio_breach'
  | 'works_during_approved_time_off'
  | 'overlapping_assignments'
  | 'excess_weekends';

export interface Violation {
  ruleId: string;
  ruleName: string;
  severity: RuleSeverity;
  code: ViolationCode;
  /** Written for a nurse manager, naming names and numbers. This text ends up in grievances. */
  message: string;
  nurseIds: Id[];
  dates: IsoDate[];
  assignmentIds: Id[];
  /** Structured payload for the UI: thresholds, actual values, the ids involved. */
  details?: Record<string, unknown>;
}

/**
 * Everything a rule needs beyond the schedule itself. Built once per evaluation pass and
 * shared by every rule, with the expensive joins precomputed.
 */
export interface RuleContext {
  unit: Unit;
  /** Acuity-derived staffing demand for the period. */
  demand: DemandTable;
  nurses: readonly Nurse[];
  shiftTypes: readonly ShiftType[];
  holidays: readonly Holiday[];
  weekendDefinition: WeekendDefinition;

  /** Approved time off only, indexed by nurse. Pending requests never block the solver. */
  approvedTimeOffByNurse: ReadonlyMap<Id, readonly TimeOffRequest[]>;
  allTimeOff: readonly TimeOffRequest[];

  credentials: readonly Credential[];
  credentialsById: ReadonlyMap<Id, Credential>;
  /** nurseId → their credential records. */
  nurseCredentials: ReadonlyMap<Id, readonly NurseCredential[]>;
  shiftCredentialRequirements: readonly ShiftCredentialRequirement[];

  /** Holiday dates as a set, for O(1) membership tests. */
  holidayDates: ReadonlySet<IsoDate>;
}

/**
 * A rule definition. `P` is the rule's parameter shape, persisted per rule set and edited
 * by the manager on the Rules screen.
 */
export interface Rule<P = Record<string, unknown>> {
  id: string;
  name: string;
  /** Shown on the Rules configuration screen, in plain language. */
  description: string;
  /** The natural severity. A rule set may override it. */
  severity: RuleSeverity;
  /** Grouping for the configuration UI. */
  category: 'rest' | 'hours' | 'coverage' | 'safety' | 'equity';
  /** Whether the verdict reads one nurse's timeline or one shift's roster. See {@link RuleScope}. */
  scope: RuleScope;
  defaultParams: P;
  evaluate(schedule: ScheduleView, params: P, ctx: RuleContext): Violation[];
}

/** A rule's configuration within a rule set. */
export interface RuleConfig<P = Record<string, unknown>> {
  ruleId: string;
  enabled: boolean;
  /** Promotes a soft rule to hard, or relaxes a hard one. Absent keeps the rule's default. */
  severityOverride?: RuleSeverity;
  params: P;
}

/**
 * A versioned collection of rule configurations. A period snapshots the version it was
 * solved under so a published schedule stays explainable even after the rules change.
 */
export interface RuleSet {
  id: Id;
  unitId: Id;
  name: string;
  version: number;
  configs: RuleConfig[];
  weekendDefinition: WeekendDefinition;
  /**
   * The soft weights: how much each fairness component counts in the objective and the
   * 0–100 score. Versioned with the rules for the same reason the rules are — a published
   * period must stay explainable under the weights it was solved with.
   */
  fairnessWeights: FairnessWeights;
  createdAt: number;
}

export interface EvaluationResult {
  violations: Violation[];
  hardViolations: Violation[];
  softViolations: Violation[];
  /** True when nothing hard is broken — the schedule is legal. */
  feasible: boolean;
}

// ---------------------------------------------------------------------------
// Helpers shared by rule implementations
// ---------------------------------------------------------------------------

/** Full name for violation messages. */
export function nurseName(nurse: Nurse): string {
  return `${nurse.firstName} ${nurse.lastName}`;
}

/** Build a violation, defaulting the id/name/severity from the rule that raised it. */
export function violation(
  rule: Pick<Rule<never>, 'id' | 'name' | 'severity'>,
  severity: RuleSeverity,
  code: ViolationCode,
  message: string,
  parts: {
    nurseIds?: Id[];
    dates?: IsoDate[];
    assignmentIds?: Id[];
    details?: Record<string, unknown>;
  } = {},
): Violation {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity,
    code,
    message,
    nurseIds: parts.nurseIds ?? [],
    dates: parts.dates ?? [],
    assignmentIds: parts.assignmentIds ?? [],
    ...(parts.details ? { details: parts.details } : {}),
  };
}

/** Assignments that count as worked bedside time — on-call standby is excluded. */
export function isWorked(view: AssignmentView): boolean {
  return !view.shiftType.isOnCall;
}
