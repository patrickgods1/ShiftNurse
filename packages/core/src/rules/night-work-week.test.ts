/**
 * Night nurses on their own work week (29 CFR 778.105: a workweek "may begin on any day and at
 * any hour", and may differ between groups of employees; Providence Portland–ONA Art. 7.A starts
 * the night nurses' week at the night shift nearest Saturday 12:01 a.m.). Expected values are
 * hand-counted. The unit week starts Sunday 00:00; 2026-01-10 and 2026-01-17 are Saturdays; the
 * pay period anchored on Sunday 4 Jan runs to Saturday 17 Jan. A 120h contract keeps the FTE rule
 * out of the way.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { windowBoundaryMinute } from '../schedule/window-split.js';
import { ruleContextForInput } from '../solver/rule-context.js';
import type { SolveCostInput } from '../solver/types.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type SolveScenarioOptions,
  scenario,
  solveInputFrom,
} from '../testing/fixtures.js';
import { maxHoursRule, overtimeHoursAround, workWeekFor } from './hours-rules.js';
import { evaluateSchedule } from './registry.js';
import type { Violation } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const CLOCK: SolveCostInput = {
  payRates: [],
  differentials: [],
  overtimeRules: [],
  overtimeWindowAttribution: 'clock',
};

/** Night nurses' week from Saturday 19:00. */
const NIGHT_SAT_19 = { nightWorkWeekStartsOn: 6, nightWorkWeekStartMinute: 1140 } as const;

const nurse = (permanentTour?: Nurse['permanentTour']) =>
  makeNurse({
    id: 'ada',
    firstName: 'Ada',
    contractedHoursPerPeriod: 120,
    ...(permanentTour ? { permanentTour } : {}),
  });

function judge(options: SolveScenarioOptions, code: string): Violation[] {
  const s = scenario(options);
  const ctx = ruleContextForInput(solveInputFrom(options));
  return evaluateSchedule(s.schedule, s.ruleSet, ctx).violations.filter((v) => v.code === code);
}

// Mon–Wed 5–7 Jan nights (36h) and the Saturday 10 Jan night, 19:00 to Sunday 07:00.
const nightsAndSaturday = () => [
  assign('ada', NIGHT_12, '2026-01-05'),
  assign('ada', NIGHT_12, '2026-01-06'),
  assign('ada', NIGHT_12, '2026-01-07'),
  assign('ada', NIGHT_12, '2026-01-10'),
];

const over = (options: SolveScenarioOptions) =>
  judge(options, 'over_max_hours').map((v) => [v.dates[0], v.amount]);

describe('the work week a nurse is judged on', () => {
  it('gives a night nurse the night week when the unit sets one', () => {
    expect(workWeekFor(nurse('night'), { workWeekStartsOn: 0, ...NIGHT_SAT_19 })).toEqual({
      startsOn: 6,
      startMinute: 1140,
    });
  });

  it('starts the night week at midnight when no time is given', () => {
    expect(workWeekFor(nurse('night'), { workWeekStartsOn: 0, nightWorkWeekStartsOn: 6 })).toEqual({
      startsOn: 6,
      startMinute: 0,
    });
  });

  it('keeps day nurses, nurses with no permanent tour and units with no night week on the unit week', () => {
    const unit = { workWeekStartsOn: 0 as const, workWeekStartMinute: 420 };
    const expected = { startsOn: 0, startMinute: 420 };
    expect(workWeekFor(nurse('day'), { ...unit, ...NIGHT_SAT_19 })).toEqual(expected);
    expect(workWeekFor(nurse(), { ...unit, ...NIGHT_SAT_19 })).toEqual(expected);
    expect(workWeekFor(nurse('night'), unit)).toEqual(expected);
    // A night time with no night day is not a night week.
    expect(workWeekFor(nurse('night'), { ...unit, nightWorkWeekStartMinute: 1140 })).toEqual(
      expected,
    );
  });
});

describe('a separate work week for night nurses', () => {
  const params = (maxHoursPerWeek: number) => ({
    'max-hours-per-week': { ...NIGHT_SAT_19, maxHoursPerWeek },
  });

  it('keeps a night nurse’s Saturday night whole in her next week, with no overtime', () => {
    // Night week from Sat 3 Jan 19:00: Mon–Wed nights, 36h. The Sat 10 Jan night starts on the
    // boundary, so all 12h are in the week from 10 Jan. 36 and 12, both within 40.
    const options: SolveScenarioOptions = {
      nurses: [nurse('night')],
      assignments: nightsAndSaturday(),
      ruleParams: params(40),
      cost: CLOCK,
    };
    expect(over(options)).toEqual([]);
    expect(judge(options, 'unauthorised_overtime')).toEqual([]);
    // Under a 35h cap only the 36h week is over, by 1, and it is dated from the Saturday.
    expect(over({ ...options, ruleParams: params(35) })).toEqual([['2026-01-03', 1]]);
  });

  it('splits a day nurse’s Saturday night at the unit week’s midnight', () => {
    // Unit week Sun 4 – Sat 10 Jan: 36 + 19:00–24:00 (5) = 41h, 1 over a 40h cap.
    const found = judge(
      {
        nurses: [nurse('day')],
        assignments: nightsAndSaturday(),
        ruleParams: params(40),
        cost: CLOCK,
      },
      'over_max_hours',
    );
    expect(found.map((v) => [v.dates[0], v.amount])).toEqual([['2026-01-04', 1]]);
    expect(found[0]!.details).toMatchObject({ scheduledHours: 41 });
  });

  it('ignores the night week for a nurse with no permanent tour', () => {
    expect(
      over({
        nurses: [nurse()],
        assignments: nightsAndSaturday(),
        ruleParams: params(40),
        cost: CLOCK,
      }),
    ).toEqual([['2026-01-04', 1]]);
  });

  it('changes nothing when only the night start time is set', () => {
    expect(
      over({
        nurses: [nurse('night')],
        assignments: nightsAndSaturday(),
        ruleParams: {
          'max-hours-per-week': { nightWorkWeekStartMinute: 1140, maxHoursPerWeek: 40 },
        },
        cost: CLOCK,
      }),
    ).toEqual([['2026-01-04', 1]]);
  });

  it('starts a night nurse’s week at midnight Saturday when no time is given', () => {
    // Night week Sat 3 Jan 00:00 – Sat 10 Jan 00:00: Mon–Wed nights (36) + the Fri 9 Jan night's
    // 19:00–24:00 (5) = 41h, 1 over 40. On the unit's Sunday week the Friday night is whole: 48.
    const options = (permanentTour: Nurse['permanentTour']): SolveScenarioOptions => ({
      nurses: [nurse(permanentTour)],
      assignments: [
        assign('ada', NIGHT_12, '2026-01-05'),
        assign('ada', NIGHT_12, '2026-01-06'),
        assign('ada', NIGHT_12, '2026-01-07'),
        assign('ada', NIGHT_12, '2026-01-09'),
      ],
      ruleParams: { 'max-hours-per-week': { nightWorkWeekStartsOn: 6, maxHoursPerWeek: 40 } },
      cost: CLOCK,
    });
    expect(over(options('night'))).toEqual([['2026-01-03', 1]]);
    expect(over(options('day'))).toEqual([['2026-01-04', 8]]);
  });

  it('moves a night nurse’s pay period to the night start time, on the same dates', () => {
    // Overtime by the pay period dated Sun 4 – Sat 17 Jan. The night week's weekday (Wednesday)
    // does not move a pay period; its time (07:00) does: the period runs to Sun 18 Jan 07:00, so
    // the Sat 17 night is whole in it. Mon–Wed of both weeks (72) + 12 = 84h, 4 past 80. A day
    // nurse's period ends at midnight: 72 + 5 = 77h, no overtime.
    const options = (permanentTour: Nurse['permanentTour']): SolveScenarioOptions => ({
      nurses: [nurse(permanentTour)],
      assignments: [
        ...['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-12', '2026-01-13', '2026-01-14'].map(
          (d) => assign('ada', DAY_12, d),
        ),
        assign('ada', NIGHT_12, '2026-01-17'),
      ],
      ruleParams: {
        'max-hours-per-week': {
          nightWorkWeekStartsOn: 3,
          nightWorkWeekStartMinute: 420,
          overtimeByPayPeriod: true,
        },
      },
      cost: CLOCK,
    });
    expect(
      judge(options('night'), 'unauthorised_overtime').map((v) => [v.dates[0], v.amount]),
    ).toEqual([['2026-01-04', 4]]);
    expect(judge(options('day'), 'unauthorised_overtime')).toEqual([]);
  });

  it('quotes a trade’s overtime from the nurse’s own week', () => {
    // At the Sat 10 Jan night's start: the night nurse's week from 10 Jan 19:00 holds 12h, no
    // overtime; the day nurse's week Sun 4 – Sat 10 holds 41h, 1 past 40.
    const at = windowBoundaryMinute(isoDate('2026-01-10'), 1140);
    const quote = (permanentTour: Nurse['permanentTour']) => {
      const options: SolveScenarioOptions = {
        nurses: [nurse(permanentTour)],
        assignments: nightsAndSaturday(),
        ruleParams: params(48),
        cost: CLOCK,
      };
      const s = scenario(options);
      const ctx = ruleContextForInput(solveInputFrom(options));
      const p = { ...maxHoursRule.defaultParams, ...NIGHT_SAT_19 };
      return overtimeHoursAround(s.schedule, 'ada', at, p, s.unit, undefined, ctx);
    };
    expect(quote('night')).toBe(0);
    expect(quote('day')).toBe(1);
  });
});
