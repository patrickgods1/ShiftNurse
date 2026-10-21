/**
 * The rule registry and evaluation entry point.
 *
 * Adding a union clause means writing one `Rule` and registering it here. Nothing in the
 * solver, the schedule grid or the compliance report needs to know it exists.
 *
 * Every judge reads a rule set through `resolveConfigs`, which refuses one holding a setting the
 * rules cannot use (`param-validation.ts`) rather than let it read as "no limit";
 * `resolveConfigsUnchecked` is only for opening such a set to fix it.
 */

import type { DemandTable } from '../acuity/demand.js';
import type {
  AvailabilityBlock,
  Credential,
  Holiday,
  Id,
  IncompatibilityGroup,
  Nurse,
  NurseCredential,
  OvertimeVolunteer,
  Preceptorship,
  Preference,
  RestWaiver,
  ShiftCredentialRequirement,
  ShiftType,
  TimeOffRequest,
  Timestamp,
  Unit,
} from '../domain/entities.js';
import { DEFAULT_WEEKEND, type IsoDate, type WeekendDefinition } from '../domain/time.js';
import { DEFAULT_FAIRNESS_WEIGHTS } from '../fairness/types.js';
import type { DstTransition } from '../schedule/real-minutes.js';
import type { ScheduleView } from '../schedule/view.js';

import { accommodationBlocksRule } from './availability-blocks.js';
import { overlapRule, timeOffRule } from './availability-rules.js';
import { completeWeekendsRule } from './complete-weekends.js';
import { coverageRule, ratioComplianceRule } from './coverage-rules.js';
import { daysOffTogetherRule } from './days-off-together.js';
import { holidayIndexes, holidayRotationRule } from './holiday-rotation.js';
import { maxHoursIn24Rule } from './hours-in-24.js';
import { contractedHoursRule, maxHoursRule } from './hours-rules.js';
import { incompatibleBufferRule, incompatibleTogetherRule } from './incompatibility-rules.js';
import { longStretchRule } from './long-stretch.js';
import { mandatoryOvertimeRule } from './mandatory-overtime.js';
import { nightRecoveryRule } from './night-recovery.js';
import { type PaidLeaveCredit, type PaidSickCall, paidLeaveCredits } from './paid-leave.js';
import { describeParamProblems, RuleParamsError, ruleConfigProblems } from './param-validation.js';
import { pendingTimeOffRule } from './pending-time-off.js';
import { preceptorRule } from './preceptor.js';
import { consecutiveShiftsRule, minRestRule } from './rest-rules.js';
import { scheduleKindToursRule } from './schedule-kind-tours.js';
import { shortWorkRunsRule } from './short-work-runs.js';
import { tourRotationRule } from './tour-rotation.js';
import type {
  EvaluationResult,
  HolidayWorkRecord,
  Rule,
  RuleConfig,
  RuleContext,
  RuleScope,
  RuleSet,
  RuleSeverity,
  Violation,
} from './types.js';
import { weekendPatternRule } from './weekend-pattern.js';

/**
 * Every rule the app ships with.
 *
 * Ordering matters only for presentation: violations come back in registry order, so the
 * compliance report reads from "unsafe" down to "unfair".
 */
export const ALL_RULES: readonly Rule<never>[] = [
  timeOffRule,
  accommodationBlocksRule,
  overlapRule,
  ratioComplianceRule,
  coverageRule,
  minRestRule,
  consecutiveShiftsRule,
  maxHoursRule,
  maxHoursIn24Rule,
  longStretchRule,
  contractedHoursRule,
  incompatibleBufferRule,
  incompatibleTogetherRule,
  holidayRotationRule,
  nightRecoveryRule,
  pendingTimeOffRule,
  mandatoryOvertimeRule,
  weekendPatternRule,
  daysOffTogetherRule,
  completeWeekendsRule,
  shortWorkRunsRule,
  preceptorRule,
  tourRotationRule,
  scheduleKindToursRule,
] as unknown as readonly Rule<never>[];

const RULES_BY_ID = new Map<string, Rule<never>>(ALL_RULES.map((r) => [r.id, r]));

export function getRule(ruleId: string): Rule<never> | undefined {
  return RULES_BY_ID.get(ruleId);
}

/**
 * Ids of the rules in a rule set that are enabled and of the given scope — optionally only those
 * hard under that rule set. A rule of the other scope would give a nonsense answer on the
 * partial views these lists are used with (one nurse's timeline, one shift's roster).
 */
export function ruleIdsByScope(
  ruleSet: RuleSet,
  scope: RuleScope,
  options: { hardOnly: boolean },
): string[] {
  const out: string[] = [];
  for (const config of resolveConfigs(ruleSet)) {
    if (!config.enabled) continue;
    const rule = RULES_BY_ID.get(config.ruleId);
    if (!rule || rule.scope !== scope) continue;
    if (options.hardOnly && (config.severityOverride ?? rule.severity) !== 'hard') continue;
    out.push(rule.id);
  }
  return out;
}

/**
 * The solver's gate list: a soft rule never gates a move. The conflict engine uses every enabled
 * rule of a scope instead, since its simulations diff soft violations too.
 */
export function hardRuleIdsByScope(ruleSet: RuleSet, scope: RuleScope): string[] {
  return ruleIdsByScope(ruleSet, scope, { hardOnly: true });
}

/**
 * Every rule enabled at its shipped defaults: the rules a new unit starts from. A template, not
 * a saved version — `saveRuleSet` stamps the
 * real time when one is saved, so `createdAt` here defaults to 0 instead of reading the clock,
 * which kept every fixture built from it different from run to run.
 */
export function defaultRuleSet(
  unitId: Id,
  name = 'Default contract rules',
  createdAt: Timestamp = 0,
): RuleSet {
  return {
    id: `ruleset-${unitId}-default`,
    unitId,
    name,
    version: 1,
    weekendDefinition: DEFAULT_WEEKEND,
    fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
    createdAt,
    configs: ALL_RULES.map<RuleConfig>((rule) => ({
      ruleId: rule.id,
      enabled: rule.enabledByDefault ?? true,
      params: rule.defaultParams as Record<string, unknown>,
    })),
  };
}

/**
 * The parameters `configs` give `rule`, typed by the rule itself. Stored params are a plain
 * record (they come from the database and from IPC), so reading them as a rule's `P` is an
 * assumption; this is the one place it is made, instead of a cast at every reader. Pass
 * resolved configs (`resolveConfigs`), whose params have the rule's defaults merged in.
 */
export function paramsOf<P>(rule: Rule<P>, configs: readonly RuleConfig[]): P | undefined {
  const config = configs.find((c) => c.ruleId === rule.id);
  return config === undefined ? undefined : asParams(rule, config.params);
}

/** As `paramsOf`, for a rule the caller has established is configured; names it if not. */
export function requireParams<P>(rule: Rule<P>, configs: readonly RuleConfig[]): P {
  const params = paramsOf(rule, configs);
  if (params === undefined) throw new Error(`The rule set has no configuration for ${rule.name}`);
  return params;
}

/** A rule's raw stored params read as its parameter type — for code handed `params` directly. */
export function asParams<P>(_rule: Rule<P>, raw: Record<string, unknown>): P {
  return raw as unknown as P;
}

/**
 * Merge a stored rule set with the registry defaults, and refuse to judge under a setting the
 * rules cannot use.
 *
 * A rule set persisted before a new rule shipped — or before a new parameter was added to an
 * existing rule — must not silently disable that rule or crash on a missing parameter. Any
 * gap falls back to the registry default. A value that is there but unusable (a `null` rest, a
 * count of 4.5) is not a gap: read as typed, it switched a check off without a word, so it throws
 * `RuleParamsError` naming each setting. Every judge — `prepareRules`, the solvers, the conflicts
 * engine, alerts — comes through here, once per pass, never per move.
 */
export function resolveConfigs(ruleSet: RuleSet): RuleConfig[] {
  const merged = resolveConfigsUnchecked(ruleSet);
  const problems = ruleConfigProblems(merged, { unknown: 'ignore' });
  if (problems.length > 0) {
    throw new RuleParamsError(
      `The rules “${ruleSet.name}” (version ${ruleSet.version}) have settings ShiftNurse cannot use: ${describeParamProblems(problems).join('; ')}. Open Settings › Rules, correct them and save a new version.`,
      problems,
    );
  }
  return merged;
}

/**
 * The merge alone, with no check. Only for code that must open an unusable rule set in order to
 * fix it: the Rules editor, and `saveRuleSet`'s comparison with the version being replaced.
 */
export function resolveConfigsUnchecked(ruleSet: RuleSet): RuleConfig[] {
  const stored = new Map(ruleSet.configs.map((c) => [c.ruleId, c]));
  return ALL_RULES.map((rule) => {
    const config = stored.get(rule.id);
    if (!config) {
      return {
        ruleId: rule.id,
        enabled: rule.enabledByDefault ?? true,
        params: rule.defaultParams as Record<string, unknown>,
      };
    }
    return {
      ...config,
      params: { ...(rule.defaultParams as Record<string, unknown>), ...(config.params ?? {}) },
    };
  });
}

/**
 * A key no rule reads cannot change a verdict; the editor drops it so a save is not refused over
 * a setting the manager cannot see.
 */
export function withoutUnknownParams(configs: readonly RuleConfig[]): RuleConfig[] {
  return configs.map((config) => {
    const rule = RULES_BY_ID.get(config.ruleId);
    if (rule === undefined) return config;
    const docs = rule.paramDocs as Record<string, unknown>;
    const params = Object.fromEntries(Object.entries(config.params).filter(([key]) => key in docs));
    return { ...config, params };
  });
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

export interface RuleContextInput {
  unit: Unit;
  demand: DemandTable;
  nurses: readonly Nurse[];
  shiftTypes: readonly ShiftType[];
  timeOff: readonly TimeOffRequest[];
  credentials: readonly Credential[];
  nurseCredentials: readonly NurseCredential[];
  shiftCredentialRequirements: readonly ShiftCredentialRequirement[];
  holidays: readonly Holiday[];
  weekendDefinition?: WeekendDefinition;
  /** Missed shifts paid from sick leave, credited toward contracted hours like paid leave. */
  paidSickCalls?: readonly PaidSickCall[];
  /** Nurses who should not be on the floor together. */
  incompatibilityGroups?: readonly IncompatibilityGroup[];
  /** Who worked each past holiday, for the holiday rotation. Absent: nobody is owed a holiday. */
  holidayWork?: readonly HolidayWorkRecord[];
  /** Standing offers to work overtime. Absent: nobody has volunteered. */
  overtimeVolunteers?: readonly OvertimeVolunteer[];
  /** Orientees and their preceptors. Absent: nobody is in orientation. */
  preceptorships?: readonly Preceptorship[];
  /** Written waivers of minimum rest. Absent: nobody has waived. */
  restWaivers?: readonly RestWaiver[];
  /** Recorded accommodations. Absent: nobody has one. */
  availabilityBlocks?: readonly AvailabilityBlock[];
  /**
   * The first date from which `priorAssignments` is known to be complete (`historyCompleteFrom`).
   * Absent: the caller has not said, and a pay period that began before the schedule is judged as
   * before (not at all, unless `onlyCompletePayPeriods` is off).
   */
  historyFrom?: IsoDate;
  /** The host's clock changes (D19). Absent: none, every day is 1440 minutes. */
  dstTransitions?: readonly DstTransition[];
  /**
   * The unit's weekly-overtime attribution, when its pay settings are loaded
   * (`RuleContext.overtimeWindowAttribution`). Absent: the start week at declared hours.
   */
  overtimeWindowAttribution?: 'clock' | 'start';
  /** Nurses' stated preferences. Absent: nobody has asked for anything. */
  preferences?: readonly Preference[];
}

/** Precompute the joins and indexes every rule needs, once per evaluation pass. */
export function buildRuleContext(input: RuleContextInput): RuleContext {
  const approvedByNurse = new Map<Id, TimeOffRequest[]>();
  const pendingByNurse = new Map<Id, TimeOffRequest[]>();
  for (const request of input.timeOff) {
    const index =
      request.status === 'approved'
        ? approvedByNurse
        : request.status === 'pending'
          ? pendingByNurse
          : undefined;
    if (!index) continue;
    const existing = index.get(request.nurseId);
    if (existing) existing.push(request);
    else index.set(request.nurseId, [request]);
  }

  const paidLeaveByNurse = new Map<Id, PaidLeaveCredit[]>();
  const workedShiftHours = input.shiftTypes
    .filter((s) => s.active && !s.isOnCall)
    .map((s) => s.durationHours);
  for (const credit of paidLeaveCredits(input.timeOff, input.paidSickCalls, workedShiftHours)) {
    const existing = paidLeaveByNurse.get(credit.nurseId);
    if (existing) existing.push(credit);
    else paidLeaveByNurse.set(credit.nurseId, [credit]);
  }

  const credentialsByNurse = new Map<Id, NurseCredential[]>();
  for (const record of input.nurseCredentials) {
    const existing = credentialsByNurse.get(record.nurseId);
    if (existing) existing.push(record);
    else credentialsByNurse.set(record.nurseId, [record]);
  }

  return {
    unit: input.unit,
    demand: input.demand,
    nurses: input.nurses,
    shiftTypes: input.shiftTypes,
    holidays: input.holidays,
    weekendDefinition: input.weekendDefinition ?? DEFAULT_WEEKEND,
    approvedTimeOffByNurse: approvedByNurse,
    pendingTimeOffByNurse: pendingByNurse,
    allTimeOff: input.timeOff,
    paidLeaveByNurse,
    credentials: input.credentials,
    credentialsById: new Map(input.credentials.map((c) => [c.id, c])),
    nurseCredentials: credentialsByNurse,
    shiftCredentialRequirements: input.shiftCredentialRequirements,
    holidayDates: new Set<IsoDate>(input.holidays.map((h) => h.date)),
    majorHolidayDates: new Set<IsoDate>(input.holidays.filter((h) => h.isMajor).map((h) => h.date)),
    ...holidayIndexes(input.holidays, input.holidayWork ?? []),
    incompatibilityGroups: input.incompatibilityGroups ?? [],
    overtimeVolunteersByNurse: groupByNurse(input.overtimeVolunteers ?? []),
    preceptorshipsByOrientee: groupByNurse(
      (input.preceptorships ?? []).map((p) => ({ ...p, nurseId: p.orienteeId })),
    ),
    restWaiversByNurse: restWaiverDates(input.restWaivers ?? []),
    availabilityBlocksByNurse: groupByNurse(input.availabilityBlocks ?? []),
    historyFrom: input.historyFrom,
    dstTransitions: input.dstTransitions ?? [],
    ...(input.overtimeWindowAttribution
      ? { overtimeWindowAttribution: input.overtimeWindowAttribution }
      : {}),
    preferredShiftTypesByNurse: preferredShiftTypes(input.preferences ?? []),
  };
}

function preferredShiftTypes(preferences: readonly Preference[]): Map<Id, Set<Id>> {
  const out = new Map<Id, Set<Id>>();
  for (const p of preferences) {
    if (p.kind !== 'prefer_shift_type') continue;
    const existing = out.get(p.nurseId);
    if (existing) existing.add(p.shiftTypeId);
    else out.set(p.nurseId, new Set([p.shiftTypeId]));
  }
  return out;
}

function restWaiverDates(waivers: readonly RestWaiver[]): Map<Id, Set<IsoDate>> {
  const out = new Map<Id, Set<IsoDate>>();
  for (const w of waivers) {
    const existing = out.get(w.nurseId);
    if (existing) existing.add(w.date);
    else out.set(w.nurseId, new Set([w.date]));
  }
  return out;
}

function groupByNurse<T extends { nurseId: Id }>(rows: readonly T[]): Map<Id, T[]> {
  const out = new Map<Id, T[]>();
  for (const row of rows) {
    const existing = out.get(row.nurseId);
    if (existing) existing.push(row);
    else out.set(row.nurseId, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** Stop at the first hard violation. The solver uses this for a fast feasibility check. */
  stopOnFirstHardViolation?: boolean;
  /** Restrict evaluation to these rule ids. */
  only?: readonly string[];
}

/**
 * A rule set resolved for repeated evaluation: the enabled rules (optionally only some ids), in
 * registry order, each with its merged params and effective severity. `evaluateSchedule` builds
 * one per call; the solver builds one per solve and reuses it for every "may this nurse take this
 * shift" check — resolving the configs was a measurable slice of a solve on its own.
 */
export interface PreparedRule {
  rule: Rule<never>;
  params: Record<string, unknown>;
  severity: RuleSeverity;
  /** The rule set's explicit severity, when it sets one; it then applies to every finding. */
  override?: RuleSeverity;
}

export function prepareRules(ruleSet: RuleSet, only?: readonly string[]): PreparedRule[] {
  const wanted = only ? new Set(only) : undefined;
  const out: PreparedRule[] = [];
  for (const config of resolveConfigs(ruleSet)) {
    if (!config.enabled) continue;
    if (wanted && !wanted.has(config.ruleId)) continue;
    const rule = RULES_BY_ID.get(config.ruleId);
    if (!rule) continue;
    out.push({
      rule,
      params: config.params,
      severity: config.severityOverride ?? rule.severity,
      ...(config.severityOverride ? { override: config.severityOverride } : {}),
    });
  }
  return out;
}

export function evaluatePrepared(
  schedule: ScheduleView,
  prepared: readonly PreparedRule[],
  ctx: RuleContext,
  stopOnFirstHardViolation = false,
): EvaluationResult {
  const violations: Violation[] = [];

  for (const { rule, params, override } of prepared) {
    const found = rule.evaluate(schedule, params as never, ctx);

    for (const item of found) {
      // A rule set may relax a hard rule to advisory, or promote a soft one. Without that, a
      // finding keeps the severity its rule gave it: the contracted-hours rule refuses hours
      // past the contract (hard) but only advises on a shortfall (soft), which is a choice a
      // manager makes, not a breach.
      violations.push(
        override === undefined || override === item.severity
          ? item
          : { ...item, severity: override },
      );
    }

    if (stopOnFirstHardViolation && violations.some((v) => v.severity === 'hard')) {
      break;
    }
  }

  const hardViolations = violations.filter((v) => v.severity === 'hard');
  return {
    violations,
    hardViolations,
    softViolations: violations.filter((v) => v.severity === 'soft'),
    feasible: hardViolations.length === 0,
  };
}

export function evaluateSchedule(
  schedule: ScheduleView,
  ruleSet: RuleSet,
  ctx: RuleContext,
  options: EvaluateOptions = {},
): EvaluationResult {
  return evaluatePrepared(
    schedule,
    prepareRules(ruleSet, options.only),
    ctx,
    options.stopOnFirstHardViolation,
  );
}

/** Group violations by nurse, for the per-nurse view on the schedule grid. */
export function violationsByNurse(violations: readonly Violation[]): Map<Id, Violation[]> {
  const out = new Map<Id, Violation[]>();
  for (const v of violations) {
    for (const nurseId of v.nurseIds) {
      const existing = out.get(nurseId);
      if (existing) existing.push(v);
      else out.set(nurseId, [v]);
    }
  }
  return out;
}

/** Group violations by date, for the grid's column badges. */
export function violationsByDate(violations: readonly Violation[]): Map<IsoDate, Violation[]> {
  const out = new Map<IsoDate, Violation[]>();
  for (const v of violations) {
    for (const date of v.dates) {
      const existing = out.get(date);
      if (existing) existing.push(v);
      else out.set(date, [v]);
    }
  }
  return out;
}

/** Group violations by the assignment they attach to, for per-cell badges. */
export function violationsByAssignment(violations: readonly Violation[]): Map<Id, Violation[]> {
  const out = new Map<Id, Violation[]>();
  for (const v of violations) {
    for (const id of v.assignmentIds) {
      const existing = out.get(id);
      if (existing) existing.push(v);
      else out.set(id, [v]);
    }
  }
  return out;
}
