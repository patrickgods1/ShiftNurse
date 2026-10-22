/**
 * A night that runs over the week's edge is counted in the week each hour was worked (21 Q1,
 * 29 CFR 778.104), as payroll pays it. Expected values are hand-counted. Weeks start Sunday;
 * 2026-01-10 and 2026-03-07 are Saturdays, and the clocks spring forward at 02:00 on Sunday
 * 2026-03-08. A 120h contract keeps the FTE rule out of the way.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import type { DstTransition } from '../schedule/real-minutes.js';
import { ruleContextForInput } from '../solver/rule-context.js';
import type { SolveCostInput } from '../solver/types.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  resetFixtureCounters,
  type SolveScenarioOptions,
  scenario,
  solveInputFrom,
} from '../testing/fixtures.js';
import { maxHoursRule, overtimeHoursAround } from './hours-rules.js';
import { evaluateSchedule } from './registry.js';
import type { Violation } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const SPRING_FORWARD: DstTransition = { atMinute: 29_548_920, deltaMinutes: 60 };

const ada = () => makeNurse({ id: 'ada', firstName: 'Ada', contractedHoursPerPeriod: 120 });

const pay = (overtimeWindowAttribution?: 'clock' | 'start'): SolveCostInput => ({
  payRates: [],
  differentials: [],
  overtimeRules: [],
  ...(overtimeWindowAttribution ? { overtimeWindowAttribution } : {}),
});

/** Judged as the app judges a period: from its SolveInput, through `ruleContextForInput`. */
function judge(options: SolveScenarioOptions, code: string): Violation[] {
  const s = scenario(options);
  const ctx = ruleContextForInput(solveInputFrom(options));
  return evaluateSchedule(s.schedule, s.ruleSet, ctx).violations.filter((v) => v.code === code);
}

// Mon–Wed 5–7 Jan on 12-hour days (36h) and the Saturday 10 Jan night, 19:00 to Sunday 07:00.
const monToWed = () => [
  assign('ada', DAY_12, '2026-01-05'),
  assign('ada', DAY_12, '2026-01-06'),
  assign('ada', DAY_12, '2026-01-07'),
];

describe('a Saturday night over the week’s edge', () => {
  it('gives the old week only the five hours before midnight', () => {
    // 36 + (19:00–24:00 = 5) = 41h against a 40h cap: 1h over.
    const found = judge(
      {
        nurses: [ada()],
        assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
        ruleParams: { 'max-hours-per-week': { maxHoursPerWeek: 40 } },
        cost: pay('clock'),
      },
      'over_max_hours',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toBe(1);
    expect(found[0]!.details).toMatchObject({ scheduledHours: 41 });
  });

  it('starts the next week with the seven Sunday-morning hours', () => {
    // Week of Sun 11 Jan: the night's 00:00–07:00 (7h) plus Sun–Tue 11–13 Jan days (36h) = 43h,
    // 3h past the 40h threshold that nobody authorised. The night is named: it adds to the week.
    const night = assign('ada', NIGHT_12, '2026-01-10');
    const found = judge(
      {
        nurses: [ada()],
        assignments: [
          night,
          assign('ada', DAY_12, '2026-01-12'),
          assign('ada', DAY_12, '2026-01-13'),
          assign('ada', DAY_12, '2026-01-14'),
        ],
        cost: pay('clock'),
      },
      'unauthorised_overtime',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toMatchObject({ scheduledHours: 43, overtimeHours: 3 });
    expect(found[0]!.assignmentIds).toContain(night.id);
  });

  it('keeps the whole night in its start week when pay attributes by start', () => {
    // 36 + 12 = 48h against a 40h cap: 8h over.
    const found = judge(
      {
        nurses: [ada()],
        assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
        ruleParams: { 'max-hours-per-week': { maxHoursPerWeek: 40 } },
        cost: pay('start'),
      },
      'over_max_hours',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toBe(8);
  });

  it('splits by the clock when the unit has not chosen an attribution', () => {
    // Pay settings present without a choice: the pay default, by the clock. 36 + 5 = 41h.
    const found = judge(
      {
        nurses: [ada()],
        assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
        ruleParams: { 'max-hours-per-week': { maxHoursPerWeek: 40 } },
        cost: pay(),
      },
      'over_max_hours',
    );
    expect(found.map((v) => v.amount)).toEqual([1]);
  });

  it('reads the week as before when no pay settings are loaded', () => {
    // No pay data: the start week at declared hours, 36 + 12 = 48h, 8h over a 40h cap.
    const found = judge(
      {
        nurses: [ada()],
        assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
        ruleParams: { 'max-hours-per-week': { maxHoursPerWeek: 40 } },
      },
      'over_max_hours',
    );
    expect(found.map((v) => v.amount)).toEqual([8]);
  });

  it('flags only the hour before midnight as unauthorised overtime', () => {
    // 41h against the 40h overtime threshold (cap 48): 1h unauthorised, not 8.
    const found = judge(
      {
        nurses: [ada()],
        assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
        cost: pay('clock'),
      },
      'unauthorised_overtime',
    );
    expect(found.map((v) => v.amount)).toEqual([1]);
  });

  it('counts a night carried in from the last schedule toward the first week', () => {
    // The published Saturday 3 Jan night gives the week of Sun 4 Jan its 00:00–07:00 (7h);
    // with Mon–Wed 5–7 Jan (36h) that is 43h, 3h unauthorised, and only this schedule's
    // shifts are named.
    const days = monToWed();
    const found = judge(
      {
        nurses: [ada()],
        priorAssignments: [assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' })],
        assignments: days,
        cost: pay('clock'),
      },
      'unauthorised_overtime',
    );
    expect(found.map((v) => v.amount)).toEqual([3]);
    expect([...found[0]!.assignmentIds].sort()).toEqual(days.map((a) => a.id).sort());
  });
});

describe('the spring-forward Saturday night', () => {
  const spring = (cost?: SolveCostInput): SolveScenarioOptions => ({
    startDate: isoDate('2026-03-01'),
    endDate: isoDate('2026-03-14'),
    nurses: [ada()],
    assignments: [
      assign('ada', DAY_12, '2026-03-02'),
      assign('ada', DAY_12, '2026-03-03'),
      assign('ada', DAY_12, '2026-03-04'),
      assign('ada', NIGHT_12, '2026-03-07'),
      assign('ada', DAY_12, '2026-03-09'),
      assign('ada', DAY_12, '2026-03-10'),
      assign('ada', DAY_12, '2026-03-11'),
    ],
    ruleParams: { 'max-hours-per-week': { maxHoursPerWeek: 40 } },
    dstTransitions: [SPRING_FORWARD],
    ...(cost ? { cost } : {}),
  });

  it('gives each week the hours actually worked in it by the clock', () => {
    // Week of 1 Mar: 36 + 5 = 41h (1 over). Week of 8 Mar: Sunday 00:00–07:00 is 6 real hours
    // (02:00–03:00 never happens) + 36 = 42h (2 over).
    const found = judge(spring(pay('clock')), 'over_max_hours');
    expect(found.map((v) => [v.dates[0], v.amount])).toEqual([
      ['2026-03-01', 1],
      ['2026-03-08', 2],
    ]);
  });

  it('counts the 11 real hours in the start week when pay attributes by start', () => {
    // Week of 1 Mar: 36 + 11 = 47h (7 over); week of 8 Mar: 36h, under.
    const found = judge(spring(pay('start')), 'over_max_hours');
    expect(found.map((v) => [v.dates[0], v.amount])).toEqual([['2026-03-01', 7]]);
  });
});

describe('overtime over the pay period', () => {
  it('leaves the Sunday hours of the last night to the next pay period', () => {
    // Pay period Sun 4 – Sat 17 Jan. Mon–Wed of both weeks (72h) and the Saturday 17 Jan night:
    // by the clock 72 + 5 = 77h, under 80; by start 72 + 12 = 84h, 4h unauthorised.
    const options = (cost: SolveCostInput): SolveScenarioOptions => ({
      nurses: [ada()],
      assignments: [
        ...monToWed(),
        assign('ada', DAY_12, '2026-01-12'),
        assign('ada', DAY_12, '2026-01-13'),
        assign('ada', DAY_12, '2026-01-14'),
        assign('ada', NIGHT_12, '2026-01-17'),
      ],
      ruleParams: { 'max-hours-per-week': { overtimeByPayPeriod: true } },
      cost,
    });
    expect(judge(options(pay('clock')), 'unauthorised_overtime')).toEqual([]);
    expect(judge(options(pay('start')), 'unauthorised_overtime').map((v) => v.amount)).toEqual([4]);
  });
});

describe("the overtime a trade's warning quotes", () => {
  it('quotes only the hour before midnight of a week-crossing night', () => {
    // 36 + 5 = 41h in the week of Sun 4 Jan: 1h past 40.
    const options: SolveScenarioOptions = {
      nurses: [ada()],
      assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
      cost: pay('clock'),
    };
    const s = scenario(options);
    const ctx = ruleContextForInput(solveInputFrom(options));
    const params = maxHoursRule.defaultParams;
    const day = isoDate('2026-01-06');
    expect(overtimeHoursAround(s.schedule, 'ada', day, params, s.unit, undefined, ctx)).toBe(1);
    // Without a rule context: the start week, 48 − 40 = 8.
    expect(overtimeHoursAround(s.schedule, 'ada', day, params, s.unit, undefined)).toBe(8);
  });
});

describe('a work week that starts at a shift change (29 CFR 778.105)', () => {
  // Saturday 19:00 is `workWeekStartsOn: 6, workWeekStartMinute: 1140`; the week dated Sat 3 Jan
  // runs from 3 Jan 19:00 to 10 Jan 19:00. Sunday 07:00 is `0, 420`.
  const SAT_19 = { workWeekStartsOn: 6, workWeekStartMinute: 1140 };
  const SUN_07 = { workWeekStartsOn: 0, workWeekStartMinute: 420 };
  const over = (options: SolveScenarioOptions) =>
    judge(options, 'over_max_hours').map((v) => [v.dates[0], v.amount]);

  for (const attribution of ['clock', 'start'] as const) {
    it(`keeps a Saturday 19:00 night out of the week it would have split (${attribution})`, () => {
      // Week from Sat 3 Jan 19:00: Mon–Wed 5–7 Jan, 36h. The Sat 10 Jan night starts on the
      // boundary, so all 12h are the next week's. 36 and 12, both within a 40h cap.
      const options = (maxHoursPerWeek: number): SolveScenarioOptions => ({
        nurses: [ada()],
        assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
        ruleParams: { 'max-hours-per-week': { ...SAT_19, maxHoursPerWeek } },
        cost: pay(attribution),
      });
      expect(over(options(40))).toEqual([]);
      expect(judge(options(40), 'unauthorised_overtime')).toEqual([]);
      // Under a 35h cap only the 36h week is over, by 1: the night adds nothing to it.
      expect(over(options(35))).toEqual([['2026-01-03', 1]]);
    });

    it(`files a 23:00 night dated Saturday in the new week (${attribution})`, () => {
      // Boundary Sat 10 Jan 19:00; the 23:00–07:00 night starts after it. Week from 10 Jan
      // 19:00: 8 + Mon–Wed 12–14 Jan (36) = 44h, 4 over a 40h cap.
      const found = over({
        nurses: [ada()],
        assignments: [
          assign('ada', NIGHT_8, '2026-01-10'),
          assign('ada', DAY_12, '2026-01-12'),
          assign('ada', DAY_12, '2026-01-13'),
          assign('ada', DAY_12, '2026-01-14'),
        ],
        shiftTypes: [DAY_12, NIGHT_12, NIGHT_8],
        ruleParams: { 'max-hours-per-week': { ...SAT_19, maxHoursPerWeek: 40 } },
        cost: pay(attribution),
      });
      expect(found).toEqual([['2026-01-10', 4]]);
    });
  }

  it('puts the Saturday night wholly in the week that ends at Sunday 07:00', () => {
    // Week from Sun 4 Jan 07:00 to Sun 11 Jan 07:00: 36 + the whole 19:00–07:00 night = 48h,
    // 8 over a 40h cap. Nothing reaches the next week.
    const found = over({
      nurses: [ada()],
      assignments: [...monToWed(), assign('ada', NIGHT_12, '2026-01-10')],
      ruleParams: { 'max-hours-per-week': { ...SUN_07, maxHoursPerWeek: 40 } },
      cost: pay('clock'),
    });
    expect(found).toEqual([['2026-01-04', 8]]);
  });

  it('puts a Sunday 19:00 night in the week that began at 07:00 that morning', () => {
    // Sun 11 Jan 19:00 is after the 07:00 boundary: week from 11 Jan holds 12 + Mon–Wed 12–14
    // Jan (36) = 48h, 8 over 40; the week before holds nothing.
    const found = over({
      nurses: [ada()],
      assignments: [
        assign('ada', NIGHT_12, '2026-01-11'),
        assign('ada', DAY_12, '2026-01-12'),
        assign('ada', DAY_12, '2026-01-13'),
        assign('ada', DAY_12, '2026-01-14'),
      ],
      ruleParams: { 'max-hours-per-week': { ...SUN_07, maxHoursPerWeek: 40 } },
      cost: pay('clock'),
    });
    expect(found).toEqual([['2026-01-11', 8]]);
  });

  it('files a Saturday day shift in the old week by its start, without pay settings too', () => {
    // No pay settings: the old reading at declared hours, but by the start instant. Sat 10 Jan
    // 07:00 is before the 19:00 boundary, so the week from 3 Jan holds 36 + 12 = 48h: 8 over 40.
    const found = over({
      nurses: [ada()],
      assignments: [...monToWed(), assign('ada', DAY_12, '2026-01-10')],
      ruleParams: { 'max-hours-per-week': { ...SAT_19, maxHoursPerWeek: 40 } },
    });
    expect(found).toEqual([['2026-01-03', 8]]);
  });

  it('lets only shifts that start in a week authorise its overtime', () => {
    // Saturday 10 Jan 07:00 day shift, marked authorised overtime, starts before the 19:00
    // boundary: it authorises the week from 3 Jan, not the one from 10 Jan. That week holds the
    // Sun 11 night (12) + Tue–Thu 13–15 Jan (36) = 48h, 8 past 40, unauthorised.
    const found = judge(
      {
        nurses: [ada()],
        assignments: [
          assign('ada', DAY_12, '2026-01-10', { isOvertime: true }),
          assign('ada', NIGHT_12, '2026-01-11'),
          assign('ada', DAY_12, '2026-01-13'),
          assign('ada', DAY_12, '2026-01-14'),
          assign('ada', DAY_12, '2026-01-15'),
        ],
        ruleParams: { 'max-hours-per-week': SAT_19 },
        cost: pay('clock'),
      },
      'unauthorised_overtime',
    );
    expect(found.map((v) => [v.dates[0], v.amount])).toEqual([['2026-01-10', 8]]);
  });

  it('judges the week a schedule opens in when its first shift starts before 19:00 Saturday', () => {
    // The schedule starts Sat 10 Jan. Its Sat 10 Jan 07:00 day starts before the 19:00
    // boundary, so it belongs to the week from Sat 3 Jan 19:00, which holds last schedule's
    // Tue–Thu 6–8 Jan (36h): 36 + 12 = 48h, 8 over a 40h cap.
    const found = over({
      startDate: isoDate('2026-01-10'),
      endDate: isoDate('2026-01-23'),
      nurses: [ada()],
      priorAssignments: ['2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign('ada', DAY_12, d, { periodId: 'prev' }),
      ),
      assignments: [assign('ada', DAY_12, '2026-01-10')],
      ruleParams: { 'max-hours-per-week': { ...SAT_19, maxHoursPerWeek: 40 } },
      cost: pay('clock'),
    });
    expect(found).toEqual([['2026-01-03', 8]]);
  });

  it('starts the pay period at the same minute', () => {
    // Overtime by the pay period dated Sun 4 – Sat 17 Jan, starting Sun 07:00: it runs to Sun
    // 18 Jan 07:00, so the Sat 17 night is wholly in it. Mon–Wed of both weeks (72) + 12 = 84h,
    // 4 past 80. (From midnight the night gave it only 5h: 77h.)
    const found = judge(
      {
        nurses: [ada()],
        assignments: [
          ...monToWed(),
          assign('ada', DAY_12, '2026-01-12'),
          assign('ada', DAY_12, '2026-01-13'),
          assign('ada', DAY_12, '2026-01-14'),
          assign('ada', NIGHT_12, '2026-01-17'),
        ],
        ruleParams: { 'max-hours-per-week': { ...SUN_07, overtimeByPayPeriod: true } },
        cost: pay('clock'),
      },
      'unauthorised_overtime',
    );
    expect(found.map((v) => v.amount)).toEqual([4]);
  });
});
