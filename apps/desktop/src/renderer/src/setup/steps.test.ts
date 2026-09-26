import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { defaultPayPeriodAnchor, type SetupCounts, stepStatus } from './steps.js';

describe('defaultPayPeriodAnchor', () => {
  it('starts pay periods on the most recent Sunday', () => {
    // Saturday 2026-09-26 → Sunday 2026-09-20.
    expect(defaultPayPeriodAnchor(isoDate('2026-09-26'))).toBe('2026-09-20');
  });

  it('uses today when today is a Sunday', () => {
    expect(defaultPayPeriodAnchor(isoDate('2026-09-20'))).toBe('2026-09-20');
  });
});

describe('stepStatus', () => {
  const empty: SetupCounts = {
    shiftTypes: 0,
    coverage: 0,
    acuityTiers: 0,
    ratioRules: 0,
    holidays: 0,
    roleRates: 0,
    nurses: 0,
  };

  it('shows a step with data as done even if it was once skipped', () => {
    expect(stepStatus('holidays', { ...empty, holidays: 11 }, ['holidays'])).toBe('done');
  });

  it('shows a skipped step with nothing in it as left for later', () => {
    expect(stepStatus('roster', empty, ['roster'])).toBe('skipped');
  });

  it('needs both tiers and ratios before acuity counts as set up', () => {
    expect(stepStatus('acuity', { ...empty, acuityTiers: 3 }, [])).toBe('empty');
    expect(stepStatus('acuity', { ...empty, acuityTiers: 3, ratioRules: 3 }, [])).toBe('done');
  });

  it('treats the rules as in force unless skipped, because the defaults always apply', () => {
    expect(stepStatus('rules', empty, [])).toBe('done');
    expect(stepStatus('rules', empty, ['rules'])).toBe('skipped');
  });
});
