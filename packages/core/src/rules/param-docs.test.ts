import { describe, expect, it } from 'vitest';

import { EMPLOYMENT_TYPES } from '../domain/entities.js';
import { ALL_RULES } from './registry.js';
import type { ParamDoc } from './types.js';

/**
 * The Rules screen renders a rule's settings from its `paramDocs`, not from its defaults: a
 * parameter without a doc is a setting no manager can see, and one with a doc but no default is
 * a field that edits nothing.
 */

function docsOf(rule: (typeof ALL_RULES)[number]): Record<string, ParamDoc> {
  return (rule.paramDocs ?? {}) as Record<string, ParamDoc>;
}

describe('rule settings shown to the manager', () => {
  it.each(ALL_RULES.map((rule) => [rule.id, rule] as const))(
    'explains every setting of %s in plain words',
    (_id, rule) => {
      const docs = docsOf(rule);
      const defaults = rule.defaultParams as Record<string, unknown>;
      for (const key of Object.keys(defaults)) {
        const doc = docs[key];
        expect(doc, `${rule.id}.${key} has no doc`).toBeDefined();
        expect(doc!.label.trim(), `${rule.id}.${key} label`).not.toBe('');
        expect(doc!.hint.trim(), `${rule.id}.${key} hint`).not.toBe('');
        expect(doc!.why.trim(), `${rule.id}.${key} why`).not.toBe('');
      }
    },
  );

  it.each(ALL_RULES.map((rule) => [rule.id, rule] as const))(
    'offers no field on %s that edits nothing',
    (_id, rule) => {
      const defaults = rule.defaultParams as Record<string, unknown>;
      for (const [key, doc] of Object.entries(docsOf(rule))) {
        if (!(key in defaults)) {
          expect(doc.optional, `${rule.id}.${key} is neither defaulted nor optional`).toBe(true);
        }
      }
    },
  );

  it('lets the manager set a longer rest after nights', () => {
    const rest = ALL_RULES.find((r) => r.id === 'min-rest-between-shifts')!;
    const doc = docsOf(rest).minRestHoursAfterNight;
    expect(doc?.optional).toBe(true);
  });

  it('asks for the work week start as a day, not a number', () => {
    const hours = ALL_RULES.find((r) => r.id === 'max-hours-per-week')!;
    expect(docsOf(hours).workWeekStartsOn?.input).toBe('weekday');
  });

  it('picks exempt employment types from the real list, so a typo cannot drop per-diem', () => {
    const contracted = ALL_RULES.find((r) => r.id === 'fte-target-hours')!;
    expect(docsOf(contracted).exemptEmploymentTypes?.input).toBe('employment-types');
    const defaults = contracted.defaultParams as { exemptEmploymentTypes: string[] };
    for (const type of defaults.exemptEmploymentTypes) {
      expect(EMPLOYMENT_TYPES).toContain(type);
    }
  });

  it('only greys a setting out behind a real on/off setting of the same rule', () => {
    for (const rule of ALL_RULES) {
      const defaults = rule.defaultParams as Record<string, unknown>;
      for (const [key, doc] of Object.entries(docsOf(rule))) {
        if (doc.activeWhen === undefined) continue;
        expect(typeof defaults[doc.activeWhen.param], `${rule.id}.${key}`).toBe('boolean');
        expect(doc.activeWhen.param).not.toBe(key);
      }
    }
  });

  it('judges the weekly overtime threshold only when overtime is weekly', () => {
    const hours = ALL_RULES.find((r) => r.id === 'max-hours-per-week')!;
    const docs = docsOf(hours);
    expect(docs.overtimeThresholdHours?.activeWhen).toEqual({
      param: 'overtimeByPayPeriod',
      equals: false,
    });
    expect(docs.payPeriodOvertimeThresholdHours?.activeWhen).toEqual({
      param: 'overtimeByPayPeriod',
      equals: true,
    });
  });
});
