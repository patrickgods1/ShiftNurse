import type { ParamDoc } from '@shiftnurse/core';
import { ALL_RULES, defaultRuleSet, resolveConfigs } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { invalidParams, numberFieldValue, paramError, withNumberParam } from './rule-params.js';

const hours: ParamDoc = { label: 'Minimum rest (hours)', hint: 'h', why: 'w' };
const afterNight: ParamDoc = { ...hours, label: 'After a night', optional: true };
const weekday: ParamDoc = { ...hours, label: 'Week starts', input: 'weekday' };
const days: ParamDoc = { ...hours, label: 'Most days in a row', min: 1 };

describe('editing a rule setting', () => {
  it('does not save a cleared minimum rest as zero hours', () => {
    const params = withNumberParam({ minRestHours: 10 }, 'minRestHours', '', hours);
    expect(params.minRestHours).not.toBe(0);
    expect(paramError(hours, 10, params.minRestHours)).toBe('Enter a number.');
  });

  it('treats a cleared rest-after-nights as "same as minimum rest"', () => {
    const params = withNumberParam(
      { minRestHours: 10, minRestHoursAfterNight: 12 },
      'minRestHoursAfterNight',
      '',
      afterNight,
    );
    expect(params).toEqual({ minRestHours: 10 });
    expect(paramError(afterNight, undefined, params.minRestHoursAfterNight)).toBeUndefined();
    expect(numberFieldValue(params.minRestHoursAfterNight)).toBe('');
  });

  it('accepts twelve hours off after a night', () => {
    const params = withNumberParam(
      { minRestHours: 10 },
      'minRestHoursAfterNight',
      '12',
      afterNight,
    );
    expect(params.minRestHoursAfterNight).toBe(12);
    expect(paramError(afterNight, undefined, 12)).toBeUndefined();
  });

  it('refuses a limit of zero days in a row', () => {
    expect(paramError(days, 5, 0)).toBe('Must be at least 1.');
    expect(paramError(days, 5, 4)).toBeUndefined();
  });

  it('refuses a negative rest', () => {
    expect(paramError(hours, 10, -2)).toBe('Must be at least 0.');
  });

  it('only takes Sunday through Saturday as the work week start', () => {
    expect(paramError(weekday, 0, 6)).toBeUndefined();
    expect(paramError(weekday, 0, 7)).toBe('Pick a day.');
  });

  it('never flags an on/off setting', () => {
    expect(paramError(hours, true, false)).toBeUndefined();
  });
});

describe('saving a rule set', () => {
  it('can save the shipped defaults as they are', () => {
    const configs = resolveConfigs(defaultRuleSet('unit-1'));
    expect(invalidParams(ALL_RULES, configs)).toEqual([]);
  });

  it('names the rule and field that block a save', () => {
    const configs = resolveConfigs(defaultRuleSet('unit-1')).map((c) =>
      c.ruleId === 'min-rest-between-shifts'
        ? { ...c, params: { ...c.params, minRestHours: '' } }
        : c,
    );
    expect(invalidParams(ALL_RULES, configs)).toEqual([
      'Minimum rest between shifts: Minimum rest (hours)',
    ]);
  });
});
