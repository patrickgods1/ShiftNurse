/**
 * Pay follows the hours actually worked (29 CFR part 785; D19): the spring-forward night is 11
 * hours and the fall-back night 13. The rules' geometry stays on the wall clock
 * (rules/dst.test.ts). Figures are worked by hand.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Differential, OvertimeRule } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import type { DstTransition } from '../schedule/real-minutes.js';
import {
  assign,
  DAY_8,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  overtimeRule,
  resetFixtureCounters,
  scenario,
  testUnit,
  UNIT_ID,
} from '../testing/fixtures.js';
import { costSchedule } from './cost.js';
import type { CostContext } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

// 2026-03-08 is day 20520 and 2026-11-01 day 20758 (2026-01-01 is 20454 = 56 × 365 + 14 leap
// days); US clocks change at 02:00, wall minute 120 of the day.
/** Spring forward: 20520 × 1440 + 120. */
const SPRING: DstTransition = { atMinute: 29_548_920, deltaMinutes: 60 };
/** Fall back: 20758 × 1440 + 120. */
const FALL: DstTransition = { atMinute: 29_891_640, deltaMinutes: -60 };

const NIGHT: Differential = {
  id: 'diff-night',
  unitId: UNIT_ID,
  kind: 'night',
  mode: 'flat',
  amount: 4.5,
  active: true,
};
const WEEKLY_40: OvertimeRule = {
  id: 'ot-weekly',
  unitId: UNIT_ID,
  basis: 'weekly',
  thresholdHours: 40,
  multiplier: 1.5,
  active: true,
};

function ctx(overrides: Partial<CostContext> = {}): CostContext {
  return {
    unit: testUnit,
    payRates: [
      {
        id: 'rate-rn',
        nurseId: null,
        role: 'RN',
        hourlyRate: 50,
        effectiveFrom: isoDate('2025-01-01'),
      },
    ],
    differentials: [],
    overtimeRules: [],
    holidayDates: new Set(),
    weekendDefinition: DEFAULT_WEEKEND,
    workWeekStartsOn: 0,
    ...overrides,
  };
}

describe('pay across a clock change', () => {
  const springNight = () => {
    const nurse = makeNurse();
    return scenario({
      startDate: isoDate('2026-03-01'),
      endDate: isoDate('2026-03-14'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-03-07')],
    });
  };
  const fallNight = () => {
    const nurse = makeNurse();
    return scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-10-31')],
    });
  };

  it('pays the spring-forward night as eleven hours', () => {
    const [cost] = costSchedule(
      springNight().schedule,
      ctx({ dstTransitions: [SPRING] }),
    ).assignments;
    expect(cost?.hours).toBe(11);
    expect(cost?.total).toBe(550); // 11h × $50
  });

  it('adds the night differential to the eleven hours of the spring-forward night', () => {
    const [cost] = costSchedule(
      springNight().schedule,
      ctx({ differentials: [NIGHT], dstTransitions: [SPRING] }),
    ).assignments;
    expect(cost?.total).toBe(599.5); // 11 × (50 + 4.50)
  });

  it('pays the fall-back night as the thirteen hours worked', () => {
    const [cost] = costSchedule(fallNight().schedule, ctx({ dstTransitions: [FALL] })).assignments;
    expect(cost?.hours).toBe(13);
    expect(cost?.total).toBe(650); // 13h × $50
  });

  it('pays the thirteenth hour of the fall-back night at double time under California’s daily rules', () => {
    const [cost] = costSchedule(
      fallNight().schedule,
      ctx({
        overtimeRules: [overtimeRule('daily', 8, 1.5), overtimeRule('daily', 12, 2)],
        dstTransitions: [FALL],
      }),
    ).assignments;
    // 8h straight, 4h at 1.5×, 1h at 2×. Base 13 × 50 = 650; premium 4 × 25 + 1 × 50 = 150.
    expect(cost?.overtimeHours).toBe(5);
    expect(cost?.lines.filter((l) => l.kind === 'overtime').map((l) => l.amount)).toEqual([
      100, 50,
    ]);
    expect(cost?.total).toBe(800);
  });

  it('pays a clock-window night differential on the nine real hours between 23:00 and 07:00 on the fall-back night', () => {
    const windowed: Differential = {
      ...differential('night', 'flat', 5),
      window: { startTime: '23:00', endTime: '07:00', wholeShiftAtHours: null },
    };
    const [cost] = costSchedule(
      fallNight().schedule,
      ctx({ differentials: [windowed], dstTransitions: [FALL] }),
    ).assignments;
    // 23:00–07:00 is 8 wall hours, plus the repeated 01:00–02:00: 9 hours × $5 = $45.
    const night = cost?.lines.find((l) => l.kind === 'night');
    expect(night?.hours).toBe(9);
    expect(night?.amount).toBe(45);
  });

  it('prices the fall-back night at twelve hours when the host reports no clock change', () => {
    const [cost] = costSchedule(fallNight().schedule, ctx()).assignments;
    expect(cost?.total).toBe(600); // 12h × $50
  });

  it('counts the spring-forward Saturday night’s six real Sunday hours in the new week: 42 hours, 2 of them overtime', () => {
    const nurse = makeNurse();
    // The 03-07 night is 11 real hours: 19:00–24:00 (5) in the week to 03-07, and 00:00–07:00 on
    // Sunday less the skipped 02:00 hour (6) in the week of 03-08 (D17). That week holds
    // 6 + 12 + 12 + 12 = 42, 2h past 40 on the 03-12 night: 600 + 2 × 25 = 650.
    const s = scenario({
      startDate: isoDate('2026-03-01'),
      endDate: isoDate('2026-03-14'),
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-03-07'),
        assign(nurse.id, NIGHT_12, '2026-03-08'),
        assign(nurse.id, NIGHT_12, '2026-03-10'),
        assign(nurse.id, NIGHT_12, '2026-03-12'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40], dstTransitions: [SPRING] }),
    );
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 2]);
    expect(report.assignments.map((a) => a.total)).toEqual([550, 600, 600, 650]);
    // Counted by its start, the whole night is the week to 03-07's, and the week of 03-08 holds 36.
    const byStart = costSchedule(
      s.schedule,
      ctx({
        overtimeRules: [WEEKLY_40],
        dstTransitions: [SPRING],
        overtimeWindowAttribution: 'start',
      }),
    );
    expect(byStart.assignments.map((a) => a.total)).toEqual([550, 600, 600, 600]);
  });
});

describe('the hours a clock change adds, on every basis that counts them', () => {
  // 2026-10-31 is a Saturday; its 19:00 night runs through the 02:00 fall-back, 13 real hours.
  const HOLIDAY_15: Differential = {
    id: 'diff-holiday',
    unitId: UNIT_ID,
    kind: 'holiday',
    mode: 'multiplier',
    amount: 1.5,
    active: true,
  };

  it('counts the fall-back Saturday night’s thirteen hours toward the weekend’s 24', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-10-31'),
        assign(nurse.id, DAY_12, '2026-11-01'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [overtimeRule('weekend', 24)], dstTransitions: [FALL] }),
    );
    // The weekend opens Saturday 00:00: the night gives it 13 real hours, Sunday's day 12 more,
    // 25 in all, 1 past 24 on Sunday: 600 + 1 × 25 = 625.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 1]);
    expect(report.assignments[1]?.total).toBe(625);
  });

  it('counts the fall-back night’s extra hour toward sixteen hours on the clock', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-10-31'),
        assign(nurse.id, DAY_8, '2026-11-01'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [overtimeRule('consecutive', 16)], dstTransitions: [FALL] }),
    );
    // One stretch from Saturday 19:00: the night is 13 real hours, so Sunday's 07:00 eight starts
    // with 13 on the clock and is past 16 after 3: 5 hours over. 8 × 50 + 5 × 25 = 525.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 5]);
    expect(report.assignments[1]?.total).toBe(525);
  });

  it('pays a Baylor nurse’s fall-back holdover hour its holiday pay and leaves the tour’s overtime its premium', () => {
    const nurse = makeNurse({ scheduleKind: 'va_baylor' });
    const s = scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-10-31', { holdoverMinutes: 60 })],
    });
    const [cost] = costSchedule(
      s.schedule,
      ctx({
        differentials: [HOLIDAY_15],
        holidayDates: new Set([isoDate('2026-10-31')]),
        holidayPayCoversOvertime: true,
        overtimeRules: [overtimeRule('daily', 8)],
        dstTransitions: [FALL],
      }),
    ).assignments;
    // The scheduled tour is 13 real hours (780 minutes), held one more: 840. Base 14 × 50 = 700.
    // § 7456(d): the tour earns no holiday pay, the held hour does, on base: 1 × 25 = 25. Daily
    // overtime runs from minute 480 to 840; holiday pay covers only the held hour (§ 7453(g)),
    // so the premium is on 480–780: 5h. Overtime hours still count all 6. The premium is on the
    // regular rate, the held hour's holiday pay in it: (700 + 25) / 14 = 51.7857… on both sides of
    // Sunday midnight (the only shift); 5 × 0.5 × 51.7857… = 129.464… → $129.46.
    expect(cost?.overtimeHours).toBe(6);
    expect(cost?.lines.find((l) => l.kind === 'holiday')).toMatchObject({ hours: 1, amount: 25 });
    expect(cost?.lines.find((l) => l.kind === 'overtime')).toMatchObject({
      hours: 5,
      amount: 129.46,
    });
    expect(cost?.total).toBe(854.46);
  });
});
