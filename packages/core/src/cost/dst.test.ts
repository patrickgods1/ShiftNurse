/**
 * Pay follows the declared 12 hours, not elapsed time: the spring-forward night really lasts 11
 * hours and the fall-back night 13, and neither may change the bill. Figures are worked by hand.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Differential, OvertimeRule } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import {
  assign,
  makeNurse,
  NIGHT_12,
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
  it('pays the spring-forward night as twelve hours', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-03-01'),
      endDate: isoDate('2026-03-14'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-03-07')],
    });
    const [cost] = costSchedule(s.schedule, ctx()).assignments;
    expect(cost?.total).toBe(600); // 12h x $50, not 11h
  });

  it('adds the night differential to all twelve hours of the spring-forward night', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-03-01'),
      endDate: isoDate('2026-03-14'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-03-07')],
    });
    const [cost] = costSchedule(s.schedule, ctx({ differentials: [NIGHT] })).assignments;
    expect(cost?.total).toBe(654); // 12 x (50 + 4.50)
  });

  it('pays the fall-back night the same twelve hours, not thirteen', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-10-31')],
    });
    const [cost] = costSchedule(s.schedule, ctx()).assignments;
    expect(cost?.total).toBe(600);
  });

  it('puts the spring-forward week at 36 hours, under the overtime threshold', () => {
    const nurse = makeNurse();
    // Sat 03-07 is last week's; Sun 03-08, Tue 03-10 and Thu 03-12 make 36h in the week to 03-14.
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
    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    const lines = report.assignments.flatMap((a) => a.lines.map((l) => l.kind));
    expect(lines).not.toContain('overtime');
    expect(report.assignments.map((a) => a.total)).toEqual([600, 600, 600, 600]);
  });
});
