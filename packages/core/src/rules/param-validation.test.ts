import { describe, expect, it } from 'vitest';

import {
  describeParamProblems,
  type ParamProblem,
  ruleConfigProblems,
} from './param-validation.js';
import { defaultRuleSet } from './registry.js';
import type { RuleConfig } from './types.js';

function config(ruleId: string, params: Record<string, unknown>): RuleConfig {
  return { ruleId, enabled: true, params };
}

function problemsOf(ruleId: string, params: Record<string, unknown>): ParamProblem[] {
  return ruleConfigProblems([config(ruleId, params)], { unknown: 'refuse' });
}

describe('rule settings the scheduler can use', () => {
  it('refuses a blank rest-after-nights saved as null, which would switch the check off', () => {
    expect(problemsOf('min-rest-between-shifts', { minRestHoursAfterNight: null })).toEqual([
      {
        ruleId: 'min-rest-between-shifts',
        key: 'minRestHoursAfterNight',
        message: 'Enter a number.',
      },
    ]);
  });

  it('takes a work week start time only as a whole minute of the day', () => {
    // 1440 is the next midnight, which is the next day's 0; -1 and 30.5 are no clock time.
    for (const bad of [1440, -1, 30.5]) {
      expect(problemsOf('max-hours-per-week', { workWeekStartMinute: bad }), String(bad)).toEqual([
        { ruleId: 'max-hours-per-week', key: 'workWeekStartMinute', message: 'Enter a time.' },
      ]);
    }
    // 19:00 Saturday, and a rule set saved before the setting existed (midnight).
    expect(problemsOf('max-hours-per-week', { workWeekStartMinute: 1140 })).toEqual([]);
    expect(problemsOf('max-hours-per-week', { workWeekStartsOn: 6 })).toEqual([]);
  });

  it('refuses a minimum rest typed as a word', () => {
    expect(problemsOf('min-rest-between-shifts', { minRestHours: 'ten' })).toEqual([
      { ruleId: 'min-rest-between-shifts', key: 'minRestHours', message: 'Enter a number.' },
    ]);
  });

  it('refuses a null weekly cap on required hours', () => {
    expect(problemsOf('no-mandatory-overtime', { maxMandatedWeeklyHours: null })).toEqual([
      {
        ruleId: 'no-mandatory-overtime',
        key: 'maxMandatedWeeklyHours',
        message: 'Enter a number.',
      },
    ]);
  });

  it('accepts an optional setting left out', () => {
    expect(problemsOf('min-rest-between-shifts', { minRestHours: 10 })).toEqual([]);
  });

  it('accepts every rule at its shipped settings', () => {
    expect(ruleConfigProblems(defaultRuleSet('u').configs, { unknown: 'refuse' })).toEqual([]);
  });

  it('refuses half a shift in a row', () => {
    expect(problemsOf('max-consecutive-shifts', { maxConsecutiveShifts: 4.5 })).toEqual([
      {
        ruleId: 'max-consecutive-shifts',
        key: 'maxConsecutiveShifts',
        message: 'Must be a whole number.',
      },
    ]);
  });

  it('refuses more hours in 24 than a day has', () => {
    expect(problemsOf('max-hours-in-24', { maxHours: 25 })).toEqual([
      { ruleId: 'max-hours-in-24', key: 'maxHours', message: 'Must be at most 24.' },
    ]);
    expect(problemsOf('max-hours-in-24', { maxHours: 24 })).toEqual([]);
  });

  it('refuses a work week that starts on an eighth day', () => {
    expect(problemsOf('max-hours-per-week', { workWeekStartsOn: 7 })).toEqual([
      { ruleId: 'max-hours-per-week', key: 'workWeekStartsOn', message: 'Pick a day.' },
    ]);
  });

  it('refuses an on/off setting stored as text', () => {
    expect(problemsOf('coverage-minimums', { requireChargeNurse: 'yes' })).toEqual([
      { ruleId: 'coverage-minimums', key: 'requireChargeNurse', message: 'Choose on or off.' },
    ]);
  });

  it('checks the charge-nurse-must-be-an-RN setting like any other switch', () => {
    expect(problemsOf('coverage-minimums', { chargeMustBeRN: 'true' })).toEqual([
      { ruleId: 'coverage-minimums', key: 'chargeMustBeRN', message: 'Choose on or off.' },
    ]);
    expect(problemsOf('coverage-minimums', { chargeMustBeRN: false })).toEqual([]);
  });

  it('refuses an exempt employment type that does not exist', () => {
    // The real value is `per_diem`; a hyphen would quietly stop exempting per-diem staff.
    expect(problemsOf('fte-target-hours', { exemptEmploymentTypes: ['per-diem'] })).toEqual([
      {
        ruleId: 'fte-target-hours',
        key: 'exemptEmploymentTypes',
        message: 'Choose from the employment types.',
      },
    ]);
  });

  it('bounds the break allowed inside a long stretch to four hours in whole minutes', () => {
    const breakOf = (value: number) =>
      problemsOf('long-stretch', { maxBreakMinutesInStretch: value }).map((p) => p.message);
    expect(breakOf(241)).toEqual(['Must be at most 240.']);
    expect(breakOf(30.5)).toEqual(['Must be a whole number.']);
    expect(breakOf(-1)).toEqual(['Must be at least 0.']);
    expect(breakOf(60)).toEqual([]);
  });

  it('refuses a setting the rule does not have when saving, and ignores it when reading', () => {
    const configs = [config('min-rest-between-shifts', { minRestHour: 8 })];
    const refused = ruleConfigProblems(configs, { unknown: 'refuse' });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('“minRestHour”');
    expect(ruleConfigProblems(configs, { unknown: 'ignore' })).toEqual([]);
  });

  it('refuses rules this version does not know when saving', () => {
    const refused = ruleConfigProblems([config('no-such-rule', {})], { unknown: 'refuse' });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('“no-such-rule”');
  });

  it('words each problem with the rule and field a manager sees', () => {
    const problems = problemsOf('min-rest-between-shifts', { minRestHoursAfterNight: null });
    expect(describeParamProblems(problems)).toEqual([
      'Minimum rest between shifts › Minimum rest after a night (hours): Enter a number.',
    ]);
  });

  it('refuses a severity that is neither hard nor advisory, and says so on the rule', () => {
    const configs: RuleConfig[] = [
      {
        ruleId: 'min-rest-between-shifts',
        enabled: true,
        severityOverride: 'medium' as never,
        params: {},
      },
    ];
    const problems = ruleConfigProblems(configs, { unknown: 'refuse' });
    expect(problems).toEqual([
      {
        ruleId: 'min-rest-between-shifts',
        key: 'severityOverride',
        message: 'Choose hard or advisory.',
      },
    ]);
    expect(describeParamProblems(problems)).toEqual([
      'Minimum rest between shifts › Severity: Choose hard or advisory.',
    ]);
  });
});
