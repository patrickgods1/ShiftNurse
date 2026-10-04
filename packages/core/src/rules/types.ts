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
  IncompatibilityGroup,
  Nurse,
  NurseCredential,
  OvertimeVolunteer,
  Preceptorship,
  ShiftCredentialRequirement,
  ShiftType,
  TimeOffRequest,
  Unit,
} from '../domain/entities.js';
import type { IsoDate, WeekendDefinition } from '../domain/time.js';
import type { FairnessWeights } from '../fairness/types.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import type { PaidLeaveCredit } from './paid-leave.js';

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
  | 'excess_weekends'
  | 'incompatible_staff_together'
  | 'incompatible_staff_unbuffered'
  | 'holiday_rotation'
  | 'holiday_pair_both'
  | 'short_recovery_after_nights'
  | 'works_during_pending_time_off'
  | 'mandatory_overtime'
  | 'orientee_without_preceptor';

/**
 * One nurse worked one past holiday. Derived from published schedules, or recorded by hand for
 * a year before the app was in use; the holiday rotation reads last year's list.
 */
export interface HolidayWorkRecord {
  holidayId: Id;
  nurseId: Id;
}

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
  /** Paid leave hours by nurse and date: approved paid leave and paid sick calls. */
  paidLeaveByNurse: ReadonlyMap<Id, readonly PaidLeaveCredit[]>;

  credentials: readonly Credential[];
  credentialsById: ReadonlyMap<Id, Credential>;
  /** nurseId → their credential records. */
  nurseCredentials: ReadonlyMap<Id, readonly NurseCredential[]>;
  shiftCredentialRequirements: readonly ShiftCredentialRequirement[];

  /** Holiday dates as a set, for O(1) membership tests. */
  holidayDates: ReadonlySet<IsoDate>;
  /** The major ones among them. */
  majorHolidayDates: ReadonlySet<IsoDate>;
  /** Every holiday by id and by date, past years included. */
  holidaysById: ReadonlyMap<Id, Holiday>;
  holidaysByDate: ReadonlyMap<IsoDate, Holiday>;
  /** holiday id → the same holiday a year earlier, when the unit has it. */
  previousHoliday: ReadonlyMap<Id, Holiday>;
  /** holiday id → the nurses who worked it. Past holidays only; see `HolidayWorkRecord`. */
  holidayWorkedBy: ReadonlyMap<Id, ReadonlySet<Id>>;

  /** Nurses who should not be on the floor together, with their dates in force. */
  incompatibilityGroups: readonly IncompatibilityGroup[];
  /** Each nurse's standing offers to work overtime. */
  overtimeVolunteersByNurse: ReadonlyMap<Id, readonly OvertimeVolunteer[]>;
  /** Each orientee's preceptorships, by orientee id. */
  preceptorshipsByOrientee: ReadonlyMap<Id, readonly Preceptorship[]>;
}

/**
 * One rule parameter as the manager sees it. The text is for someone who knows the contract,
 * not the code: `hint` says what the setting does, `why` when and why a unit would change it.
 */
export interface ParamDoc {
  label: string;
  hint: string;
  why: string;
  /** An editor other than the one the default's type implies: a number that is a weekday, a
   * string list drawn from the employment types. */
  input?: 'weekday' | 'employment-types';
  /** The parameter may be absent; the hint says what absence falls back to. */
  optional?: boolean;
  /** The smallest number that makes sense. Absent means 0. */
  min?: number;
  /** The parameter only matters while a boolean parameter of the same rule has this value. */
  activeWhen?: { param: string; equals: boolean };
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
  /**
   * False for a rule a unit opts into (a law or contract term only some units have): it starts
   * disabled in a new rule set and in any stored rule set saved before it shipped. Absent: on.
   */
  enabledByDefault?: boolean;
  /**
   * What each parameter means to a manager, keyed like `P`. The Rules screen builds its form
   * from this, so the type demands a doc for every key — optional ones included, which is how a
   * setting with no default (a longer rest after nights) stays reachable at all.
   */
  paramDocs: { [K in keyof Required<P>]-?: ParamDoc };
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
/**
 * A number a rule put in `details`, for code that computes with it. Throws when it is missing
 * or not a number: these payloads are loosely typed, and reading a renamed key as `?? 0` once
 * turned "short 2 RNs" into a shortfall of zero — a silently wrong staffing number, which is
 * worse than a crash. Use `detailOptional` only where the rule may legitimately omit the field.
 */
export function detailNumber(v: Violation, key: string): number {
  const value = v.details?.[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Violation ${v.code} from ${v.ruleId} has no number "${key}" in its details`);
  }
  return value;
}

/** A string a rule put in `details` — an id, a role. Throws when missing, like `detailNumber`. */
export function detailString(v: Violation, key: string): string {
  const value = v.details?.[key];
  if (typeof value !== 'string') {
    throw new Error(`Violation ${v.code} from ${v.ruleId} has no "${key}" in its details`);
  }
  return value;
}

/** A detail the rule may leave out (a requirement for any role has no `role`). */
export function detailOptional<T = unknown>(v: Violation, key: string): T | undefined {
  return v.details?.[key] as T | undefined;
}

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
