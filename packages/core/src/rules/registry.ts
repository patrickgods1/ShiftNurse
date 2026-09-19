/**
 * The rule registry and evaluation entry point.
 *
 * Adding a union clause means writing one `Rule` and registering it here. Nothing in the
 * solver, the schedule grid or the compliance report needs to know it exists.
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
import { DEFAULT_WEEKEND, type IsoDate, type WeekendDefinition } from '../domain/time.js';
import { DEFAULT_FAIRNESS_WEIGHTS } from '../fairness/types.js';
import type { ScheduleView } from '../schedule/view.js';

import { overlapRule, timeOffRule } from './availability-rules.js';
import { coverageRule, ratioComplianceRule } from './coverage-rules.js';
import { contractedHoursRule, maxHoursRule } from './hours-rules.js';
import { consecutiveShiftsRule, minRestRule } from './rest-rules.js';
import type {
  EvaluationResult,
  Rule,
  RuleConfig,
  RuleContext,
  RuleScope,
  RuleSet,
  RuleSeverity,
  Violation,
} from './types.js';

/**
 * Every rule the app ships with.
 *
 * Ordering matters only for presentation: violations come back in registry order, so the
 * compliance report reads from "unsafe" down to "unfair".
 */
export const ALL_RULES: readonly Rule<never>[] = [
  timeOffRule,
  overlapRule,
  ratioComplianceRule,
  coverageRule,
  minRestRule,
  consecutiveShiftsRule,
  maxHoursRule,
  contractedHoursRule,
] as unknown as readonly Rule<never>[];

const RULES_BY_ID = new Map<string, Rule<never>>(ALL_RULES.map((r) => [r.id, r]));

export function getRule(ruleId: string): Rule<never> | undefined {
  return RULES_BY_ID.get(ruleId);
}

/**
 * Ids of the rules in a rule set that are enabled, hard under that rule set, and of the given
 * scope. This is the list the solver hands to `evaluateSchedule`'s `only` option when it
 * checks one nurse's timeline or one shift's roster in isolation; a soft rule never gates a
 * move, and a rule of the other scope would give a nonsense answer on a partial view.
 */
export function hardRuleIdsByScope(ruleSet: RuleSet, scope: RuleScope): string[] {
  const out: string[] = [];
  for (const config of resolveConfigs(ruleSet)) {
    if (!config.enabled) continue;
    const rule = RULES_BY_ID.get(config.ruleId);
    if (!rule || rule.scope !== scope) continue;
    if ((config.severityOverride ?? rule.severity) !== 'hard') continue;
    out.push(rule.id);
  }
  return out;
}

/** A rule set enabling every rule at its shipped defaults. The starting point for a new unit. */
export function defaultRuleSet(unitId: Id, name = 'Default contract rules'): RuleSet {
  return {
    id: `ruleset-${unitId}-default`,
    unitId,
    name,
    version: 1,
    weekendDefinition: DEFAULT_WEEKEND,
    fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
    createdAt: Date.now(),
    configs: ALL_RULES.map<RuleConfig>((rule) => ({
      ruleId: rule.id,
      enabled: true,
      params: rule.defaultParams as Record<string, unknown>,
    })),
  };
}

/**
 * Merge a stored rule set with the registry defaults.
 *
 * A rule set persisted before a new rule shipped — or before a new parameter was added to an
 * existing rule — must not silently disable that rule or crash on a missing parameter. Any
 * gap falls back to the registry default.
 */
export function resolveConfigs(ruleSet: RuleSet): RuleConfig[] {
  const stored = new Map(ruleSet.configs.map((c) => [c.ruleId, c]));
  return ALL_RULES.map((rule) => {
    const config = stored.get(rule.id);
    if (!config) {
      return {
        ruleId: rule.id,
        enabled: true,
        params: rule.defaultParams as Record<string, unknown>,
      };
    }
    return {
      ...config,
      params: { ...(rule.defaultParams as Record<string, unknown>), ...(config.params ?? {}) },
    };
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
}

/** Precompute the joins and indexes every rule needs, once per evaluation pass. */
export function buildRuleContext(input: RuleContextInput): RuleContext {
  const approvedByNurse = new Map<Id, TimeOffRequest[]>();
  for (const request of input.timeOff) {
    if (request.status !== 'approved') continue;
    const existing = approvedByNurse.get(request.nurseId);
    if (existing) existing.push(request);
    else approvedByNurse.set(request.nurseId, [request]);
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
    allTimeOff: input.timeOff,
    credentials: input.credentials,
    credentialsById: new Map(input.credentials.map((c) => [c.id, c])),
    nurseCredentials: credentialsByNurse,
    shiftCredentialRequirements: input.shiftCredentialRequirements,
    holidayDates: new Set<IsoDate>(input.holidays.map((h) => h.date)),
  };
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

export function evaluateSchedule(
  schedule: ScheduleView,
  ruleSet: RuleSet,
  ctx: RuleContext,
  options: EvaluateOptions = {},
): EvaluationResult {
  const violations: Violation[] = [];
  const configs = resolveConfigs(ruleSet);

  for (const config of configs) {
    if (!config.enabled) continue;
    if (options.only && !options.only.includes(config.ruleId)) continue;
    const rule = RULES_BY_ID.get(config.ruleId);
    if (!rule) continue;

    const severity: RuleSeverity = config.severityOverride ?? rule.severity;
    const found = rule.evaluate(schedule, config.params as never, ctx);

    for (const item of found) {
      // A rule set may relax a hard rule to advisory, or promote a soft one.
      violations.push(severity === item.severity ? item : { ...item, severity });
    }

    if (options.stopOnFirstHardViolation && violations.some((v) => v.severity === 'hard')) {
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

/** Fast path for the solver: is this schedule legal at all? */
export function isFeasible(schedule: ScheduleView, ruleSet: RuleSet, ctx: RuleContext): boolean {
  return evaluateSchedule(schedule, ruleSet, ctx, { stopOnFirstHardViolation: true }).feasible;
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
