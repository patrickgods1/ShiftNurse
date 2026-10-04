import { describe, expect, it } from 'vitest';
import { rulesSchemas } from './rules.js';

describe('a rule set arriving over IPC', () => {
  const weights = {
    nights: 1,
    weekends: 1,
    holidays: 1,
    onCall: 1,
    undesirable: 1,
    overtime: 1,
    preferences: 1,
    timeOff: 1,
  };
  const weekend = { startWeekday: 6, startMinute: 0, durationMinutes: 2880, mode: 'starts_within' };
  const configs = [
    { ruleId: 'min-rest', enabled: true, params: { minRestHours: 10 } },
    { ruleId: 'night-recovery', enabled: true, severityOverride: 'hard', params: {} },
  ];

  it('accepts the rule set the editor saves, whatever parameters each rule has', () => {
    expect(
      rulesSchemas.save.safeParse(['u-1', 'Contract 2026', configs, weekend, weights]).success,
    ).toBe(true);
  });

  it('refuses a severity that is neither hard nor soft', () => {
    const bad = [{ ruleId: 'min-rest', enabled: true, severityOverride: 'maybe', params: {} }];
    expect(rulesSchemas.save.safeParse(['u-1', 'x', bad, weekend, weights]).success).toBe(false);
  });

  it('refuses a rule whose parameters are not a set of named values', () => {
    const bad = [{ ruleId: 'min-rest', enabled: true, params: 10 }];
    expect(rulesSchemas.save.safeParse(['u-1', 'x', bad, weekend, weights]).success).toBe(false);
  });

  it('refuses a fairness weight that is missing', () => {
    const { timeOff: _timeOff, ...partial } = weights;
    expect(rulesSchemas.save.safeParse(['u-1', 'x', configs, weekend, partial]).success).toBe(
      false,
    );
  });
});
