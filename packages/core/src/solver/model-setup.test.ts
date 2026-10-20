import { beforeEach, describe, expect, it } from 'vitest';

import { maxHoursRule } from '../rules/hours-rules.js';
import { makeNurse, resetFixtureCounters, solveInputFrom } from '../testing/fixtures.js';
import { costContextFor } from './model-setup.js';
import { ruleContextForInput } from './rule-context.js';
import type { SolveInput } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

function contextFor(cost: NonNullable<SolveInput['cost']>) {
  const input = solveInputFrom({ nurses: [makeNurse()], cost });
  return costContextFor(input, ruleContextForInput(input), maxHoursRule.defaultParams);
}

describe('pricing Generate’s candidates', () => {
  const base = { payRates: [], differentials: [], overtimeRules: [] };

  it('prices Generate’s candidates with the unit’s additive stacking', () => {
    const ctx = contextFor({ ...base, premiumStacking: 'additive' });
    expect(ctx?.premiumStacking).toBe('additive');
  });

  it('carries the unit’s holiday coverage and week attribution to Generate', () => {
    const ctx = contextFor({
      ...base,
      holidayPayCoversOvertime: true,
      overtimeWindowAttribution: 'start',
    });
    expect(ctx?.holidayPayCoversOvertime).toBe(true);
    expect(ctx?.overtimeWindowAttribution).toBe('start');
  });

  it('leaves the pay settings absent for a unit that sent none', () => {
    const ctx = contextFor(base);
    expect(ctx?.premiumStacking).toBeUndefined();
    expect(ctx?.overtimeWindowAttribution).toBeUndefined();
  });
});
