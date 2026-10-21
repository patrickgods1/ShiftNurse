import type { ParamDoc } from '@shiftnurse/core';
import { ALL_RULES, defaultRuleSet, resolveConfigs } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import {
  anchorWeekday,
  invalidParams,
  nearestMidnightShiftChange,
  numberFieldValue,
  paramError,
  timeFieldValue,
  weekdayFieldValue,
  withNumberParam,
  withTimeParam,
  withWeekdayParam,
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

describe('lining the work week up with the shift change nearest midnight', () => {
  it('starts the week the evening before when the night shift change is nearest', () => {
    expect(nearestMidnightShiftChange([420, 1140], 0)).toEqual({ weekday: 6, minute: 1140 });
  });

  it('starts the week at the morning change when that is nearest midnight', () => {
    expect(nearestMidnightShiftChange([420, 900], 0)).toEqual({ weekday: 0, minute: 420 });
  });

  it('picks 23:00 over 07:00', () => {
    expect(nearestMidnightShiftChange([1380, 420], 0)).toEqual({ weekday: 6, minute: 1380 });
  });

  it('keeps midnight itself on the same weekday', () => {
    expect(nearestMidnightShiftChange([0, 720], 1)).toEqual({ weekday: 1, minute: 0 });
  });

  it('prefers the evening change when 05:00 and 19:00 are equally far from midnight', () => {
    expect(nearestMidnightShiftChange([300, 1140], 0)).toEqual({ weekday: 6, minute: 1140 });
    expect(nearestMidnightShiftChange([1140, 300], 0)).toEqual({ weekday: 6, minute: 1140 });
  });

  it('says nothing when the unit has no shifts', () => {
    expect(nearestMidnightShiftChange([], 0)).toBeUndefined();
  });
});

describe('which midnight a work-week start is anchored to', () => {
  it.each([
    [6, 1140, 0],
    [0, 420, 0],
    [0, 0, 0],
    [3, 720, 4],
  ] as const)('weekday %i at minute %i is anchored to weekday %i', (day, minute, expected) => {
    expect(anchorWeekday(day, minute)).toBe(expected);
  });
});

describe('leaving the night nurses’ work week empty', () => {
  const maxHours = ALL_RULES.find((r) => r.id === 'max-hours-per-week')!;
  const docs = maxHours.paramDocs as Record<string, ParamDoc>;
  const nightDay = docs.nightWorkWeekStartsOn!;
  const nightTime = docs.nightWorkWeekStartMinute!;
  const unitTime = docs.workWeekStartMinute!;

  it('saves a cleared night start time as not set, so the night week starts at midnight', () => {
    const params = withTimeParam(
      { nightWorkWeekStartsOn: 6, nightWorkWeekStartMinute: 1140 },
      'nightWorkWeekStartMinute',
      '',
      nightTime,
    );
    expect(params).toEqual({ nightWorkWeekStartsOn: 6 });
    expect(paramError(nightTime, undefined, params.nightWorkWeekStartMinute)).toBeUndefined();
  });

  it('still blocks the save when the unit’s own start time is cleared', () => {
    const params = withTimeParam(
      { workWeekStartMinute: 1140 },
      'workWeekStartMinute',
      '',
      unitTime,
    );
    expect(params.workWeekStartMinute).toBe('');
    expect(paramError(unitTime, 0, params.workWeekStartMinute)).toBe('Enter a number.');
  });

  it('shows an unset night weekday as “Not set” and saves “Not set” as absent', () => {
    expect(weekdayFieldValue(undefined)).toBe('');
    expect(weekdayFieldValue(6)).toBe('6');
    const set = withWeekdayParam({}, 'nightWorkWeekStartsOn', '6', nightDay);
    expect(set).toEqual({ nightWorkWeekStartsOn: 6 });
    expect(withWeekdayParam(set, 'nightWorkWeekStartsOn', '', nightDay)).toEqual({});
    expect(paramError(nightDay, undefined, undefined)).toBeUndefined();
  });

  it('picks Sunday as day 0, not as “Not set”', () => {
    expect(withWeekdayParam({}, 'nightWorkWeekStartsOn', '0', nightDay)).toEqual({
      nightWorkWeekStartsOn: 0,
    });
  });

  it('lets a rule set with no night week be saved', () => {
    const configs = resolveConfigs(defaultRuleSet('unit-1'));
    expect(invalidParams(ALL_RULES, configs)).toEqual([]);
  });
});
