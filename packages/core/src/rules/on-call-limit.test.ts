import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { busyElsewhere } from '../schedule/elsewhere.js';
import type { ScenarioOptions } from '../testing/fixtures.js';
import {
  assign,
  DAY_12,
  makeNurse,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
} from '../testing/fixtures.js';
import { type OnCallLimitParams, onCallLimitRule } from './on-call-limit.js';
import { ruleConfigProblems } from './param-validation.js';
import { defaultRuleSet } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

// The default schedule period is Sun 4 – Sat 17 Jan 2026. Weeks start on Sunday by default:
// the week of Sun Jan 4 is 4–10, the week of Sun Jan 11 is 11–17.
const ana = (extra: Partial<Nurse> = {}) =>
  makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz', ...extra });

const onCall = (date: string, id?: string, extra: Partial<Assignment> = {}) =>
  assign('ana', ON_CALL, date, { ...(id ? { id } : {}), ...extra });
const prior = (date: string, id?: string) => onCall(date, id, { periodId: 'prev' });

function evaluate(
  assignments: Assignment[],
  params: Partial<OnCallLimitParams> = {},
  options: ScenarioOptions & { nurse?: Nurse } = {},
) {
  const { nurse, ...rest } = options;
  const s = scenario({ nurses: [nurse ?? ana()], assignments, ...rest });
  return onCallLimitRule.evaluate(
    s.schedule,
    { ...onCallLimitRule.defaultParams, ...params },
    s.ctx,
  );
}

describe('on-call limits', () => {
  it('ships advisory, off, and with no limits until a unit sets them', () => {
    expect(onCallLimitRule).toMatchObject({
      id: 'on-call-limit',
      severity: 'soft',
      scope: 'nurse',
      enabledByDefault: false,
      defaultParams: { workWeekStartsOn: 0 },
    });
    const config = defaultRuleSet('unit-1').configs.find((c) => c.ruleId === 'on-call-limit');
    expect(config?.enabled).toBe(false);
  });

  it('flags a nurse on call Monday, Wednesday and Friday when the unit allows two a week', () => {
    // Mon 5, Wed 7, Fri 9 are all in the week of Sun Jan 4: 3 on call against 2, over by 1.
    const found = evaluate(
      [onCall('2026-01-05', 'mon'), onCall('2026-01-07', 'wed'), onCall('2026-01-09', 'fri')],
      { maxOnCallPerWeek: 2 },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'too_much_on_call',
      severity: 'soft',
      amount: 1,
      nurseIds: ['ana'],
      dates: ['2026-01-05', '2026-01-07', '2026-01-09'],
      assignmentIds: ['mon', 'wed', 'fri'],
      details: { count: 3, maximum: 2, weekStart: '2026-01-04' },
    });
    expect(found[0]!.message).toBe(
      'Ana Cruz is on call 3 times in the week of Sun Jan 4, 2026; this unit allows 2.',
    );
  });

  it('does not count a day shift worked as a turn on call', () => {
    // Mon 5 and Wed 7 on call, Fri 9 a day shift: 2 on call against 2, not over.
    expect(
      evaluate([onCall('2026-01-05'), onCall('2026-01-07'), assign('ana', DAY_12, '2026-01-09')], {
        maxOnCallPerWeek: 2,
      }),
    ).toEqual([]);
  });

  it('counts the call taken last schedule in the same week', () => {
    // Schedule from Wed 7. Mon 5 on call was published; Thu 8 and Fri 9 are this schedule's.
    // The week of Sun Jan 4 holds 1 + 2 = 3 against 2: over by 1, naming only Thu and Fri.
    const found = evaluate(
      [onCall('2026-01-08', 'thu'), onCall('2026-01-09', 'fri')],
      { maxOnCallPerWeek: 2 },
      { startDate: isoDate('2026-01-07'), priorAssignments: [prior('2026-01-05', 'mon')] },
    );
    expect(found.map((v) => [v.amount, v.assignmentIds, v.details])).toEqual([
      [1, ['thu', 'fri'], { count: 3, maximum: 2, weekStart: '2026-01-04' }],
    ]);
  });

  it('leaves a week whose only call was last schedule’s alone', () => {
    // Schedule from Wed 7. Mon 5 and Tue 6 on call, published: 2 against 1, but nothing in this
    // schedule to change. Wed 7 is a day shift; the next call is Mon 12, alone in its week.
    expect(
      evaluate(
        [assign('ana', DAY_12, '2026-01-07'), onCall('2026-01-12')],
        { maxOnCallPerWeek: 1 },
        {
          startDate: isoDate('2026-01-07'),
          priorAssignments: [prior('2026-01-05'), prior('2026-01-06')],
        },
      ),
    ).toEqual([]);
  });

  it('counts the work week from the day the unit names', () => {
    // Sat 10 and Sun 11 on call. From Sunday they fall in two weeks, one each: nothing over 1.
    // From Monday both fall in the week of Mon Jan 5: 2 against 1, over by 1.
    const weekend = [onCall('2026-01-10', 'sat'), onCall('2026-01-11', 'sun')];
    expect(evaluate(weekend, { maxOnCallPerWeek: 1 })).toEqual([]);
    const found = evaluate(weekend, { maxOnCallPerWeek: 1, workWeekStartsOn: 1 });
    expect(found.map((v) => [v.amount, v.assignmentIds, v.details])).toEqual([
      [1, ['sat', 'sun'], { count: 2, maximum: 1, weekStart: '2026-01-05' }],
    ]);
  });

  it('counts call in this schedule only against the schedule’s limit', () => {
    // Schedule Wed 7 – Sat 17. Mon 5 and Tue 6 were on call last schedule; Thu 8, Mon 12 and
    // Wed 14 are this schedule's: 3 against 2, over by 1 (not 5 − 2 = 3).
    const found = evaluate(
      [onCall('2026-01-08', 'a'), onCall('2026-01-12', 'b'), onCall('2026-01-14', 'c')],
      { maxOnCallPerPeriod: 2 },
      {
        startDate: isoDate('2026-01-07'),
        priorAssignments: [prior('2026-01-05'), prior('2026-01-06')],
      },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      amount: 1,
      assignmentIds: ['a', 'b', 'c'],
      details: { count: 3, maximum: 2 },
    });
    expect(found[0]!.message).toBe(
      'Ana Cruz is on call 3 times in this schedule (Wed Jan 7 – Sat Jan 17); this unit allows 2.',
    );
  });

  it('flags a run of call days that began last schedule', () => {
    // Schedule from Wed 7. Mon 5 and Tue 6 on call, published; Wed 7 on call here. Three days in a
    // row against 2: the window Mon 5 – Wed 7 is one too many, over by 3 − 2 = 1, naming Wed.
    const found = evaluate(
      [onCall('2026-01-07', 'wed')],
      { maxConsecutiveOnCallDays: 2 },
      {
        startDate: isoDate('2026-01-07'),
        priorAssignments: [prior('2026-01-05'), prior('2026-01-06')],
      },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      amount: 1,
      dates: ['2026-01-07'],
      assignmentIds: ['wed'],
      details: { days: 3, maximum: 2, from: '2026-01-05' },
    });
    expect(found[0]!.message).toBe(
      'Ana Cruz is on call 3 days in a row (Mon Jan 5 – Wed Jan 7); this unit allows 2.',
    );
  });

  it('leaves a run of call days entirely in last schedule alone', () => {
    // Schedule from Thu 8. Mon 5, Tue 6, Wed 7 on call, published: 3 in a row against 2, all
    // history. Thu 8 is a day shift, which is not call and ends the run.
    expect(
      evaluate(
        [assign('ana', DAY_12, '2026-01-08')],
        { maxConsecutiveOnCallDays: 2 },
        {
          startDate: isoDate('2026-01-08'),
          priorAssignments: [prior('2026-01-05'), prior('2026-01-06'), prior('2026-01-07')],
        },
      ),
    ).toEqual([]);
  });

  it('flags each further day on call in a row past the limit', () => {
    // Mon 5 – Thu 8 on call, four days in a row against 2: the windows of three days Mon–Wed and
    // Tue–Thu are each one day too many, so 2 findings of 1.
    const found = evaluate(
      [
        onCall('2026-01-05', 'mon'),
        onCall('2026-01-06', 'tue'),
        onCall('2026-01-07', 'wed'),
        onCall('2026-01-08', 'thu'),
      ],
      { maxConsecutiveOnCallDays: 2 },
    );
    expect(found.map((v) => [v.amount, v.assignmentIds])).toEqual([
      [1, ['mon', 'tue', 'wed']],
      [1, ['tue', 'wed', 'thu']],
    ]);
  });

  it('says nothing with no limit set, however much call a nurse takes', () => {
    const everyDay = [
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
    ].map((d) => onCall(d));
    expect(evaluate(everyDay)).toEqual([]);
  });

  it('holds per-diem and part-time nurses to the same limits', () => {
    // Mon 5 and Tue 6 on call against 1 a week: over by 1, whoever takes the call.
    const call = [onCall('2026-01-05'), onCall('2026-01-06')];
    for (const employmentType of ['per_diem', 'part_time'] as const) {
      const found = evaluate(call, { maxOnCallPerWeek: 1 }, { nurse: ana({ employmentType }) });
      expect(
        found.map((v) => v.amount),
        employmentType,
      ).toEqual([1]);
    }
  });

  it('counts call taken on another unit toward the week', () => {
    // Mon 5 on call for 5 West, Tue 6 on call here: 2 in the week against 1, over by 1. 5 West's
    // call is named by nobody here; on its own it is that unit's to judge.
    const WEST = { ...ON_CALL, id: 'west-oc', unitId: 'unit-west' };
    const west = busyElsewhere(
      [assign('ana', WEST, '2026-01-05', { periodId: 'west' })],
      [WEST],
      '5 West',
    );
    const options = {
      shiftTypes: [...testShiftTypes, ...west.shiftTypes],
      priorAssignments: west.assignments,
    };
    const found = evaluate([onCall('2026-01-06', 'tue')], { maxOnCallPerWeek: 1 }, options);
    expect(found.map((v) => [v.amount, v.assignmentIds])).toEqual([[1, ['tue']]]);
    expect(evaluate([], { maxOnCallPerWeek: 0 }, options)).toEqual([]);
  });

  it('accepts a blank limit and refuses a negative or part one', () => {
    const problems = (params: Record<string, unknown>) =>
      ruleConfigProblems([{ ruleId: 'on-call-limit', enabled: true, params }], {
        unknown: 'refuse',
      }).map((p) => p.key);
    expect(problems({})).toEqual([]);
    expect(problems({ maxOnCallPerWeek: 0, maxOnCallPerPeriod: 4 })).toEqual([]);
    expect(problems({ maxOnCallPerWeek: -1 })).toEqual(['maxOnCallPerWeek']);
    expect(problems({ maxOnCallPerPeriod: 1.5 })).toEqual(['maxOnCallPerPeriod']);
    expect(problems({ maxConsecutiveOnCallDays: null })).toEqual(['maxConsecutiveOnCallDays']);
    expect(problems({ workWeekStartsOn: 7 })).toEqual(['workWeekStartsOn']);
  });
});
