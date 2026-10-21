import type { ParamDoc } from '@shiftnurse/core';
import { ALL_RULES, defaultRuleSet, resolveConfigs } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import {
  invalidParams,
  numberFieldValue,
  paramError,
  timeFieldValue,
  withNumberParam,
  withTimeParam,
} from './rule-params.js';

const hours: ParamDoc = { label: 'Minimum rest (hours)', hint: 'h', why: 'w' };
const afterNight: ParamDoc = { ...hours, label: 'After a night', optional: true };
const weekday: ParamDoc = { ...hours, label: 'Week starts', input: 'weekday' };
const days: ParamDoc = { ...hours, label: 'Most days in a row', min: 1 };
const startsAt: ParamDoc = {
  ...hours,
  label: 'Work week starts at',
  input: 'time-of-day',
  integer: true,
  max: 1439,
};

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

  it('shows a Saturday 19:00 week start as 19:00 and saves the time picked as minutes', () => {
    // 19 × 60 = 1140; 07:30 is 7 × 60 + 30 = 450.
    expect(timeFieldValue(1140)).toBe('19:00');
    expect(timeFieldValue(0)).toBe('00:00');
    const params = withTimeParam({ workWeekStartMinute: 1140 }, 'workWeekStartMinute', '07:30');
    expect(params.workWeekStartMinute).toBe(450);
    expect(paramError(startsAt, 0, 450)).toBeUndefined();
  });

  it('does not save a cleared week start time as midnight', () => {
    const params = withTimeParam({ workWeekStartMinute: 1140 }, 'workWeekStartMinute', '');
    expect(params.workWeekStartMinute).not.toBe(0);
    expect(paramError(startsAt, 0, params.workWeekStartMinute)).toBe('Enter a number.');
    expect(timeFieldValue(params.workWeekStartMinute)).toBe('');
  });

  it('only takes Sunday through Saturday as the work week start', () => {
    expect(paramError(weekday, 0, 6)).toBeUndefined();
    expect(paramError(weekday, 0, 7)).toBe('Pick a day.');
  });

  it('never flags an on/off setting', () => {
    expect(paramError(hours, true, false)).toBeUndefined();
  });

  it('refuses a count of nights in a row that is not whole', () => {
    const rule = ALL_RULES.find((r) => r.id === 'max-consecutive-shifts')!;
    const doc = (rule.paramDocs as Record<string, ParamDoc>).maxConsecutiveNights!;
    expect(paramError(doc, 3, 2.5)).toBe('Must be a whole number.');
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

  it('flags an on/off setting that is not on or off', () => {
    const configs = resolveConfigs(defaultRuleSet('unit-1')).map((c) =>
      c.ruleId === 'coverage-minimums'
        ? { ...c, params: { ...c.params, requireChargeNurse: 'yes' } }
        : c,
    );
    expect(invalidParams(ALL_RULES, configs)).toContain(
      'Coverage minimums and skill mix: Require a charge nurse',
    );
  });
});
