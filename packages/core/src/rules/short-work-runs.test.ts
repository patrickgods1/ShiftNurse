import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { busyElsewhere } from '../schedule/elsewhere.js';
import type { ScenarioOptions } from '../testing/fixtures.js';
import {
  assign,
  DAY_8,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
} from '../testing/fixtures.js';
import { ruleConfigProblems } from './param-validation.js';
import { defaultRuleSet } from './registry.js';
import { type ShortWorkRunsParams, shortWorkRunsRule } from './short-work-runs.js';

beforeEach(() => {
  resetFixtureCounters();
});

// The default schedule period is Sun 4 – Sat 17 Jan 2026: Mon 5, Tue 6, … Fri 16, Sat 17.
const ana = (extra: Partial<Nurse> = {}) =>
  makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz', ...extra });

function evaluate(
  assignments: Assignment[],
  params: Partial<ShortWorkRunsParams> = {},
  options: ScenarioOptions & { nurse?: Nurse } = {},
) {
  const { nurse, ...rest } = options;
  const s = scenario({ nurses: [nurse ?? ana()], assignments, ...rest });
  return shortWorkRunsRule.evaluate(
    s.schedule,
    { ...shortWorkRunsRule.defaultParams, ...params },
    s.ctx,
  );
}

describe('short work runs', () => {
  it('ships advisory and off until a unit turns it on', () => {
    expect(shortWorkRunsRule).toMatchObject({
      id: 'short-work-runs',
      severity: 'soft',
      scope: 'nurse',
      enabledByDefault: false,
      defaultParams: { minConsecutiveDays: 2, exemptEmploymentTypes: ['per_diem'] },
    });
    const config = defaultRuleSet('unit-1').configs.find((c) => c.ruleId === 'short-work-runs');
    expect(config?.enabled).toBe(false);
  });

  it('flags a lone Monday between two days off', () => {
    // Sun 4 off, Mon 5 worked, Tue 6 off: a run of 1 against a minimum of 2, short by 2 − 1 = 1.
    const found = evaluate([assign('ana', DAY_12, '2026-01-05', { id: 'mon' })]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'short_work_run',
      severity: 'soft',
      amount: 1,
      nurseIds: ['ana'],
      dates: ['2026-01-05'],
      assignmentIds: ['mon'],
      details: { length: 1, minimum: 2 },
    });
    expect(found[0]!.message).toBe(
      'Ana Cruz works only 1 day in a row (Mon Jan 5, 2026); the unit asks for at least 2.',
    );
  });

  it('accepts Monday and Tuesday worked together', () => {
    expect(
      evaluate([assign('ana', DAY_12, '2026-01-05'), assign('ana', DAY_12, '2026-01-06')]),
    ).toEqual([]);
  });

  it('flags two days in a row when the unit asks for three', () => {
    // Mon 5 and Tue 6: a run of 2 against a minimum of 3, short by 3 − 2 = 1.
    const found = evaluate(
      [
        assign('ana', DAY_12, '2026-01-05', { id: 'mon' }),
        assign('ana', DAY_12, '2026-01-06', { id: 'tue' }),
      ],
      { minConsecutiveDays: 3 },
    );
    expect(found.map((v) => [v.amount, v.assignmentIds, v.details])).toEqual([
      [1, ['mon', 'tue'], { length: 2, minimum: 3 }],
    ]);
    expect(found[0]!.message).toBe(
      'Ana Cruz works only 2 days in a row (Mon Jan 5 – Tue Jan 6); the unit asks for at least 3.',
    );
  });

  it('leaves a run that reaches the schedule’s last day to the next schedule', () => {
    // Sat 17 is the last day: the next schedule may add Sun 18 to it.
    expect(evaluate([assign('ana', DAY_12, '2026-01-17')])).toEqual([]);
    expect(
      evaluate([assign('ana', DAY_12, '2026-01-16'), assign('ana', DAY_12, '2026-01-17')], {
        minConsecutiveDays: 3,
      }),
    ).toEqual([]);
    // Fri 16 alone has Sat 17 off inside the schedule: judged, short by 2 − 1 = 1.
    expect(evaluate([assign('ana', DAY_12, '2026-01-16')]).map((v) => v.amount)).toEqual([1]);
  });

  it('counts the Sunday worked last schedule toward a Monday run', () => {
    // Schedule from Mon 5; Sun 4 published in the lookback tail. Sun 4 + Mon 5 is a run of 2.
    const options = {
      startDate: isoDate('2026-01-05'),
      priorAssignments: [assign('ana', DAY_12, '2026-01-04', { periodId: 'prev' })],
    };
    expect(evaluate([assign('ana', DAY_12, '2026-01-05')], {}, options)).toEqual([]);
    // A lone day in the tail alone is history: nothing in this schedule to fix.
    expect(evaluate([], {}, options)).toEqual([]);
  });

  it('does not judge a lone first day whose day before is missing from the history', () => {
    // Sun 4 worked; Sat 3 before the schedule. History complete from Sun 4: Sat 3 is unknown.
    // Complete from Sat 3: it was off, a run of 1, short by 1.
    const sunday = [assign('ana', DAY_12, '2026-01-04')];
    expect(evaluate(sunday, {}, { historyFrom: isoDate('2026-01-04') })).toEqual([]);
    expect(
      evaluate(sunday, {}, { historyFrom: isoDate('2026-01-03') }).map((v) => v.amount),
    ).toEqual([1]);
  });

  it('exempts per-diem nurses by default, and judges them once the unit says so', () => {
    const perDiem = ana({ employmentType: 'per_diem' });
    const monday = [assign('ana', DAY_12, '2026-01-05')];
    expect(evaluate(monday, {}, { nurse: perDiem })).toEqual([]);
    expect(
      evaluate(monday, { exemptEmploymentTypes: [] }, { nurse: perDiem }).map((v) => v.amount),
    ).toEqual([1]);
  });

  it('counts a Monday night that ends Tuesday morning as one day, dated by its start', () => {
    // Night Mon 5 19:00 – Tue 6 07:00: dated Monday, so Tuesday is a day off. Run of 1: short by 1.
    const found = evaluate([assign('ana', NIGHT_12, '2026-01-05', { id: 'night' })]);
    expect(found.map((v) => [v.amount, v.assignmentIds])).toEqual([[1, ['night']]]);
  });

  it('does not count a day on call as a day worked', () => {
    // Mon 5 worked, Tue 6 on call: the run is Monday alone, short by 1.
    const found = evaluate([
      assign('ana', DAY_12, '2026-01-05', { id: 'mon' }),
      assign('ana', ON_CALL, '2026-01-06'),
    ]);
    expect(found.map((v) => [v.amount, v.assignmentIds])).toEqual([[1, ['mon']]]);
  });

  it('counts a day worked on another unit as a day worked', () => {
    // Mon 5 here, Tue 6 on 5 West: two days in a row for the nurse. 5 West's day is named by
    // nobody here, and on its own it is that unit's to judge.
    const WEST = { ...DAY_8, id: 'west-d8', unitId: 'unit-west' };
    const west = busyElsewhere(
      [assign('ana', WEST, '2026-01-06', { periodId: 'west' })],
      [WEST],
      '5 West',
    );
    const options = {
      shiftTypes: [...testShiftTypes, ...west.shiftTypes],
      priorAssignments: west.assignments,
    };
    expect(evaluate([assign('ana', DAY_12, '2026-01-05')], {}, options)).toEqual([]);
    expect(evaluate([], {}, options)).toEqual([]);
  });

  it('refuses a minimum below two days or a part day', () => {
    const problems = (params: Record<string, unknown>) =>
      ruleConfigProblems([{ ruleId: 'short-work-runs', enabled: true, params }], {
        unknown: 'refuse',
      }).map((p) => p.key);
    expect(problems({ minConsecutiveDays: 1 })).toEqual(['minConsecutiveDays']);
    expect(problems({ minConsecutiveDays: 2.5 })).toEqual(['minConsecutiveDays']);
    expect(problems({ exemptEmploymentTypes: ['per-diem'] })).toEqual(['exemptEmploymentTypes']);
    expect(problems({ minConsecutiveDays: 3, exemptEmploymentTypes: ['agency'] })).toEqual([]);
  });
});
