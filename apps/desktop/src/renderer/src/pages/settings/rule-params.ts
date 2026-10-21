/**
 * What the Rules screen may save. A number field holds whatever the manager typed until it is a
 * number again: the first version turned a cleared field into `Number('') === 0`, so blanking
 * "Minimum rest" to retype it saved a rule set requiring 0 hours between shifts.
 */

import {
  type ParamDoc,
  paramProblem as paramError,
  type Rule,
  type RuleConfig,
} from '@shiftnurse/core';

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

/**
 * What an `<input type="time">` shows for a time-of-day param held as minutes after midnight:
 * "19:00" for 1140. A value that is not a whole minute of the day shows blank, and `paramError`
 * says why.
 */
export function timeFieldValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= 1440) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

/**
 * The params after the manager picked `raw` ("HH:MM", or '' when cleared) in a time field. A
 * cleared field is kept as typed so `paramError` blocks the save, as a cleared number is.
 */
export function withTimeParam(
  params: Record<string, unknown>,
  key: string,
  raw: string,
): Record<string, unknown> {
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  return { ...params, [key]: match ? Number(match[1]) * 60 + Number(match[2]) : raw };
}

/**
 * Why a param's value cannot be saved, or undefined when it can. Core's definition, so the form
 * is never stricter or looser than the repository and the rule engine.
 */
export { paramError };

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
