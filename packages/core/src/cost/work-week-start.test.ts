/**
 * A work week (or 8/80 pay period) may begin at any hour (29 CFR 778.105, 778.601(b)); payroll
 * often starts it at the shift change nearest midnight so no night is split. Figures are worked by
 * hand: $50 base, no differentials, so a 1.5× premium hour is $25 and a 12-hour shift $600.
 * 2026-01-10 and 2026-01-17 are Saturdays.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  scenario,
  testUnit,
} from '../testing/fixtures.js';
import { costSchedule } from './cost.js';
import type { CostContext } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const WEEKLY_40 = overtimeRule('weekly', 40);

function ctx(overrides: Partial<CostContext> = {}): CostContext {
  return {
    unit: testUnit,
    payRates: [payRate(50)],
    differentials: [],
    overtimeRules: [WEEKLY_40],
    holidayDates: new Set(),
    weekendDefinition: DEFAULT_WEEKEND,
    workWeekStartsOn: 0,
    ...overrides,
  };
}

/** Saturday 19:00: `workWeekStartsOn: 6`, 1140 minutes after midnight. */
const SAT_19 = { workWeekStartsOn: 6, workWeekStartMinute: 1140 } as const;

// Wed–Fri 7–9 Jan on 12s, then the Saturday 10 Jan night.
const threeThenNight = () => {
  const nurse = makeNurse();
  return scenario({
    nurses: [nurse],
    assignments: [
      ...['2026-01-07', '2026-01-08', '2026-01-09'].map((d) => assign(nurse.id, DAY_12, d)),
      assign(nurse.id, NIGHT_12, '2026-01-10'),
    ],
  });
};

// The Saturday 10 Jan night, then Mon–Wed 12–14 Jan on 12s.
const nightThenThree = () => {
  const nurse = makeNurse();
  return scenario({
    nurses: [nurse],
    assignments: [
      assign(nurse.id, NIGHT_12, '2026-01-10'),
      ...['2026-01-12', '2026-01-13', '2026-01-14'].map((d) => assign(nurse.id, DAY_12, d)),
    ],
  });
};

describe('a work week that starts at Saturday 19:00', () => {
  it('pays no overtime on a Saturday night after three 12s: the night opens the next week', () => {
    // From midnight Sunday the week held 36 + 5 = 41 (1h over). From Saturday 19:00 the week
    // from 3 Jan holds 36 and the night is wholly the next week's.
    const report = costSchedule(threeThenNight().schedule, ctx(SAT_19));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0]);
    expect(report.totals.overtimeHours).toBe(0);
  });

  it('counts the whole Saturday night toward the week after it', () => {
    // Week from 10 Jan 19:00: 12 + 36 = 48, 8h past 40, the last 8 of Wednesday's 12.
    // 600 + 8 × 25 = 800. (From midnight Sunday the night gave the week only 7: 43, 3h over.)
    const report = costSchedule(nightThenThree().schedule, ctx(SAT_19));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8]);
    expect(report.assignments.map((a) => a.total)).toEqual([600, 600, 600, 800]);
  });

  it('counts a Saturday day shift in the week that ends at 19:00 that evening', () => {
    // Wed–Fri 7–9 Jan and Sat 10 Jan 07:00–19:00, all before the 19:00 boundary: the week from
    // 3 Jan holds 48, 8h past 40 on Saturday's 12, 600 + 8 × 25 = 800. From Saturday midnight
    // the Saturday shift opened the next week and nothing was over.
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });
    const at19 = costSchedule(s.schedule, ctx(SAT_19));
    expect(at19.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8]);
    expect(at19.assignments[3]?.total).toBe(800);
    const atMidnight = costSchedule(s.schedule, ctx({ workWeekStartsOn: 6 }));
    expect(atMidnight.totals.overtimeHours).toBe(0);
  });

  it('prices the same whether the unit counts by the clock or by start, since nothing is split', () => {
    const start = costSchedule(
      nightThenThree().schedule,
      ctx({ ...SAT_19, overtimeWindowAttribution: 'start' }),
    );
    expect(start.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8]);
  });
});

describe('a work week that starts at midnight', () => {
  it('prices exactly as before the start time existed when it is set to midnight', () => {
    // 36 + 5 = 41: the night's 23:00–24:00 hour is overtime, 600 + 25 = 625.
    const without = costSchedule(threeThenNight().schedule, ctx());
    resetFixtureCounters();
    const atMidnight = costSchedule(threeThenNight().schedule, ctx({ workWeekStartMinute: 0 }));
    expect(atMidnight).toEqual(without);
    expect(atMidnight.assignments[3]?.overtimeHours).toBe(1);
    expect(atMidnight.assignments[3]?.total).toBe(625);
  });
});

describe('an 8/80 pay period that starts at Sunday 07:00', () => {
  it('keeps the last Saturday night wholly in the pay period it starts in', () => {
    // Pay period dated 4–17 Jan, from Sun 4 Jan 07:00 to Sun 18 Jan 07:00. Mon–Wed of both weeks
    // (72) + the Sat 17 night (12) = 84, 4h past 80. From midnight it held 72 + 5 = 77.
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-31'),
      nurses: [nurse],
      assignments: [
        ...['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-12', '2026-01-13', '2026-01-14'].map(
          (d) => assign(nurse.id, DAY_12, d),
        ),
        assign(nurse.id, NIGHT_12, '2026-01-17'),
      ],
    });
    const eighty = { overtimeRules: [overtimeRule('pay_period', 80)] };
    expect(costSchedule(s.schedule, ctx(eighty)).totals.overtimeHours).toBe(0);
    const shifted = costSchedule(s.schedule, ctx({ ...eighty, workWeekStartMinute: 420 }));
    expect(shifted.totals.overtimeHours).toBe(4);
  });
});

describe('night nurses on their own work week (29 CFR 778.105)', () => {
  // The unit's week from midnight Sunday; night nurses' from Saturday 19:00 (Providence
  // Portland–ONA Art. 7.A). Nia is on permanent nights, Dee on days; both work the same shifts.
  const team = (dates: readonly string[], night: string, type = NIGHT_12) => {
    const nia = makeNurse({ id: 'nia', permanentTour: 'night' });
    const dee = makeNurse({ id: 'dee', permanentTour: 'day' });
    return scenario({
      nurses: [nia, dee],
      assignments: [nia, dee].flatMap((n) => [
        ...dates.map((d) => assign(n.id, type, d)),
        assign(n.id, NIGHT_12, night),
      ]),
    });
  };
  const NIGHT_WEEK = { nightWorkWeekStartsOn: 6, nightWorkWeekStartMinute: 1140 } as const;
  const of = (report: ReturnType<typeof costSchedule>, nurseId: string) =>
    report.assignments.filter((a) => a.nurseId === nurseId);

  it('prices a night nurse’s Saturday night with no overtime, and the day nurse’s first hour', () => {
    // Mon–Wed 5–7 Jan nights (36h) and the Sat 10 Jan night. Nia: 36 in the week from 3 Jan
    // 19:00, then 12 in the next, none over 40. Dee: the unit week holds 36 + 5 (19:00–24:00) =
    // 41, 1h over: 600 + 25 = 625.
    const s = team(['2026-01-05', '2026-01-06', '2026-01-07'], '2026-01-10');
    const report = costSchedule(s.schedule, ctx(NIGHT_WEEK));
    expect(of(report, 'nia').map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0]);
    expect(of(report, 'nia').map((a) => a.total)).toEqual([600, 600, 600, 600]);
    expect(of(report, 'dee').map((a) => a.overtimeHours)).toEqual([0, 0, 0, 1]);
    expect(of(report, 'dee').map((a) => a.total)).toEqual([600, 600, 600, 625]);
  });

  it('starts a night nurse’s pay period at the night time, on the usual dates', () => {
    // 8/80 over the pay period Sun 4 – Sat 17 Jan. The night weekday (Wednesday) cannot move a pay
    // period; the 07:00 does: Nia's runs to Sun 18 Jan 07:00, so Mon–Wed of both weeks (72) and
    // the whole Sat 17 night make 84, 4h over on the night: 600 + 4 × 25 = 700. Dee's ends at
    // midnight: 72 + 5 = 77, none over.
    const s = team(
      ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-12', '2026-01-13', '2026-01-14'],
      '2026-01-17',
      DAY_12,
    );
    const report = costSchedule(
      s.schedule,
      ctx({
        overtimeRules: [overtimeRule('pay_period', 80)],
        nightWorkWeekStartsOn: 3,
        nightWorkWeekStartMinute: 420,
      }),
    );
    expect(of(report, 'nia').map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 0, 4]);
    expect(of(report, 'nia').at(-1)?.total).toBe(700);
    expect(of(report, 'dee').map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
