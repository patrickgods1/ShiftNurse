/**
 * What the Rules screen may save. A number field holds whatever the manager typed until it is a
 * number again: the first version turned a cleared field into `Number('') === 0`, so blanking
 * "Minimum rest" to retype it saved a rule set requiring 0 hours between shifts.
 */

import type { ParamDoc, Rule, RuleConfig } from '@shiftnurse/core';

/** The value a number input should hold for a param: '' for an unset optional one. */
export function numberFieldValue(value: unknown): string {
  return value === undefined ? '' : String(value);
}

/**
 * The params after the manager typed `raw` into a number field. A blank optional param is
 * removed (the rule falls back); anything else that is not a number is kept as typed, which
 * `paramError` then reports and which blocks saving.
 */
export function withNumberParam(
  params: Record<string, unknown>,
  key: string,
  raw: string,
  doc: ParamDoc,
): Record<string, unknown> {
  if (raw.trim() === '' && doc.optional) {
    const { [key]: _removed, ...rest } = params;
    return rest;
  }
  const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
  return { ...params, [key]: Number.isFinite(parsed) ? parsed : raw };
}

/** Why a param's value cannot be saved, or undefined when it can. */
export function paramError(
  doc: ParamDoc,
  defaultValue: unknown,
  value: unknown,
): string | undefined {
  const numeric = typeof defaultValue === 'number' || (doc.optional && defaultValue === undefined);
  if (!numeric) return undefined;
  if (value === undefined) return doc.optional ? undefined : 'Enter a number.';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
  if (doc.input === 'weekday') {
    return Number.isInteger(value) && value >= 0 && value <= 6 ? undefined : 'Pick a day.';
  }
  const min = doc.min ?? 0;
  return value < min ? `Must be at least ${min}.` : undefined;
}

/** Every unsaveable field across a rule set's configs, as "Rule name: Field label". */
export function invalidParams(
  rules: readonly Rule<never>[],
  configs: readonly RuleConfig[],
): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const config = configs.find((c) => c.ruleId === rule.id);
    if (config === undefined) continue;
    const defaults = rule.defaultParams as Record<string, unknown>;
    for (const [key, doc] of Object.entries(rule.paramDocs as Record<string, ParamDoc>)) {
      if (paramError(doc, defaults[key], config.params[key]) !== undefined) {
        out.push(`${rule.name}: ${doc.label}`);
      }
    }
  }
  return out;
}
