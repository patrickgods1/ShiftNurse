/**
 * What counts as a usable rule parameter, defined once.
 *
 * Stored params are a plain record from the database and from IPC, and the rules read them as
 * typed. A `null` or a word where a number belongs was read as "no limit" or as "always
 * breached": a blank "rest after a night" saved as `null` made `0 >= null` true, so the
 * night-to-day turnaround was never flagged. Rule-set versions are immutable, so such a value
 * stayed in force for every schedule judged under it, and the renderer's form check was the only
 * thing that stood in the way. `paramProblem` is that check moved here, so the form, the save and
 * the judging all apply the same definition.
 */

import { EMPLOYMENT_TYPES } from '../domain/entities.js';
import { getRule } from './registry.js';
import type { ParamDoc, RuleConfig } from './types.js';

/** Why `value` cannot be this parameter's setting, or undefined when it can. */
export function paramProblem(
  doc: ParamDoc,
  defaultValue: unknown,
  value: unknown,
): string | undefined {
  // The kind comes from the default. Every optional parameter without one is a number, which is
  // how the editor has always read it.
  if (typeof defaultValue === 'number' || (doc.optional && defaultValue === undefined)) {
    if (value === undefined) return doc.optional ? undefined : 'Enter a number.';
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
    if (doc.input === 'weekday') {
      return Number.isInteger(value) && value >= 0 && value <= 6 ? undefined : 'Pick a day.';
    }
    if (doc.integer && !Number.isInteger(value)) return 'Must be a whole number.';
    const min = doc.min ?? 0;
    if (value < min) return `Must be at least ${min}.`;
    if (doc.max !== undefined && value > doc.max) return `Must be at most ${doc.max}.`;
    return undefined;
  }
  if (typeof defaultValue === 'boolean') {
    // Booleans always have a default and are merged, so even `undefined` here is a stored value.
    return typeof value === 'boolean' ? undefined : 'Choose on or off.';
  }
  if (Array.isArray(defaultValue)) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      return 'Choose from the list.';
    }
    if (
      doc.input === 'employment-types' &&
      !value.every((v) => (EMPLOYMENT_TYPES as readonly string[]).includes(v))
    ) {
      return 'Choose from the employment types.';
    }
  }
  return undefined;
}

/** The `key` of a problem with the rule's severity override rather than one of its params. */
const SEVERITY_KEY = 'severityOverride';

/** One unusable setting in a rule set. `key` is '' when the rule itself is the problem. */
export interface ParamProblem {
  ruleId: string;
  key: string;
  /** Plain words, completed by `describeParamProblems`. */
  message: string;
}

/**
 * Every unusable setting in `configs`, judged on the params each rule will actually read: the
 * stored ones over the rule's defaults. `'refuse'` also reports what no rule reads (an unknown
 * rule, an unknown key) and a severity override that is neither hard nor soft — a save must not
 * keep them — while `'ignore'` is for judging, where an unknown rule is dropped and an unknown
 * key changes no verdict.
 */
export function ruleConfigProblems(
  configs: readonly RuleConfig[],
  options: { unknown: 'refuse' | 'ignore' },
): ParamProblem[] {
  const refuse = options.unknown === 'refuse';
  const out: ParamProblem[] = [];
  for (const config of configs) {
    const rule = getRule(config.ruleId);
    if (rule === undefined) {
      if (refuse) {
        out.push({
          ruleId: config.ruleId,
          key: '',
          message: `names a rule this version of ShiftNurse does not know (“${config.ruleId}”)`,
        });
      }
      continue;
    }
    const defaults = rule.defaultParams as Record<string, unknown>;
    const docs = rule.paramDocs as Record<string, ParamDoc>;
    const stored = config.params ?? {};
    const merged = { ...defaults, ...stored };
    for (const [key, doc] of Object.entries(docs)) {
      const message = paramProblem(doc, defaults[key], merged[key]);
      if (message !== undefined) out.push({ ruleId: rule.id, key, message });
    }
    if (!refuse) continue;
    for (const key of Object.keys(stored)) {
      if (key in docs) continue;
      out.push({
        ruleId: rule.id,
        key,
        message: `has a setting this version of ShiftNurse does not know (“${key}”)`,
      });
    }
    const override = config.severityOverride as unknown;
    if (override !== undefined && override !== 'hard' && override !== 'soft') {
      out.push({ ruleId: rule.id, key: SEVERITY_KEY, message: 'Choose hard or advisory.' });
    }
  }
  return out;
}

/** Thrown when a rule set is read for judging with a setting the rules cannot use. */
export class RuleParamsError extends Error {
  readonly problems: readonly ParamProblem[];

  constructor(message: string, problems: readonly ParamProblem[]) {
    super(message);
    this.name = 'RuleParamsError';
    this.problems = problems;
  }
}

/** "Rule name › Field label: message", one per problem, for a manager. */
export function describeParamProblems(problems: readonly ParamProblem[]): string[] {
  return problems.map((p) => {
    const rule = getRule(p.ruleId);
    if (rule !== undefined && p.key === SEVERITY_KEY)
      return `${rule.name} › Severity: ${p.message}`;
    const doc =
      rule === undefined ? undefined : (rule.paramDocs as Record<string, ParamDoc>)[p.key];
    if (rule === undefined || doc === undefined) {
      return `${rule?.name ?? 'The rule set'} ${p.message}`;
    }
    return `${rule.name} › ${doc.label}: ${p.message}`;
  });
}
