/**
 * Every expected dollar figure here is worked by hand from the pay model in `types.ts`, never
 * re-derived with the code's own arithmetic. The fixture rates are deliberately "round":
 * RN $48, night +$4.50, weekend +$3, charge +$2.50, holiday ×1.5, on-call $6 standby, weekly
 * overtime past 40h at ×1.5. 2026-01-04 is a Sunday.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Assignment, Differential, OvertimeRule, PayRate } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import {
  assign,
  DAY_8,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testUnit,
  UNIT_ID,
} from '../testing/fixtures.js';
import { compareToBudget, costSchedule, marginalCost } from './cost.js';
import type { CostContext } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const RN_RATE: PayRate = {
  id: 'rate-rn',
  nurseId: null,
  role: 'RN',
  hourlyRate: 48,
  effectiveFrom: isoDate('2025-01-01'),
};

function diff(
  kind: Differential['kind'],
  mode: Differential['mode'],
  amount: number,
): Differential {
  return { id: `diff-${kind}`, unitId: UNIT_ID, kind, mode, amount, active: true };
}

const NIGHT = diff('night', 'flat', 4.5);
const WEEKEND = diff('weekend', 'flat', 3);
const HOLIDAY = diff('holiday', 'multiplier', 1.5);
const CHARGE = diff('charge', 'flat', 2.5);
const ON_CALL_FLAT = diff('on_call', 'flat', 6);
const AGENCY = diff('agency', 'multiplier', 1.25);

const WEEKLY_40: OvertimeRule = {
  id: 'ot-weekly',
  unitId: UNIT_ID,
  basis: 'weekly',
  thresholdHours: 40,
  multiplier: 1.5,
  active: true,
};
const DAILY_8: OvertimeRule = {
  id: 'ot-daily',
  unitId: UNIT_ID,
  basis: 'daily',
  thresholdHours: 8,
  multiplier: 1.5,
  active: true,
};

function ctx(overrides: Partial<CostContext> = {}): CostContext {
  return {
    unit: testUnit,
    payRates: [RN_RATE],
    differentials: [NIGHT, WEEKEND, HOLIDAY, CHARGE, ON_CALL_FLAT, AGENCY],
    overtimeRules: [],
    holidayDates: new Set(),
    weekendDefinition: DEFAULT_WEEKEND,
    workWeekStartsOn: 0,
    ...overrides,
  };
}

function lineAmounts(cost: { lines: { kind: string; amount: number }[] }): Record<string, number> {
  return Object.fromEntries(cost.lines.map((l) => [l.kind, l.amount]));
}

describe('pricing one shift', () => {
  it('prices a weekday day shift at base rate alone', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, DAY_12, '2026-01-05')] });

    const report = costSchedule(s.schedule, ctx());
    const [cost] = report.assignments;
    expect(cost?.total).toBe(576); // 12h × $48
    expect(cost?.straightRate).toBe(48);
    expect(cost?.rateSource).toBe('role');
    expect(cost?.lines.map((l) => l.kind)).toEqual(['base']);
  });

  it('adds the night differential per hour', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-05')],
    });

    const [cost] = costSchedule(s.schedule, ctx()).assignments;
    expect(cost?.total).toBe(630); // 12 × (48 + 4.50)
    expect(lineAmounts(cost!)).toEqual({ base: 576, night: 54 });
  });

  it('stacks night, weekend and charge as flat dollars per hour', () => {
    const nurse = makeNurse();
    // Saturday night, in charge: $48 + 4.50 + 3 + 2.50 = $58/h.
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-10', { isCharge: true })],
    });

    const [cost] = costSchedule(s.schedule, ctx()).assignments;
    expect(cost?.straightRate).toBe(58);
    expect(cost?.total).toBe(696);
    expect(lineAmounts(cost!)).toEqual({ base: 576, night: 54, weekend: 36, charge: 30 });
  });

  it('applies the holiday premium to the rate including flat differentials', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05', { isCharge: true })],
    });

    // Regular rate $48 + 2.50 = $50.50; the holiday premium is half of that again per hour.
    const [cost] = costSchedule(
      s.schedule,
      ctx({ holidayDates: new Set([isoDate('2026-01-05')]) }),
    ).assignments;
    expect(cost?.straightRate).toBeCloseTo(75.75);
    expect(lineAmounts(cost!)).toEqual({ base: 576, charge: 30, holiday: 303 });
    expect(cost?.total).toBe(909);
  });

  it('does not treat the night shift into a holiday morning as a holiday shift', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-05')],
    });

    const [cost] = costSchedule(
      s.schedule,
      ctx({ holidayDates: new Set([isoDate('2026-01-06')]) }),
    ).assignments;
    expect(cost?.total).toBe(630);
  });

  it('pays on-call standby at the on-call rate only, whatever night or weekend it falls on', () => {
    const nurse = makeNurse();
    // Saturday night standby: no base pay, no night or weekend differential — $6 × 12h.
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, ON_CALL, '2026-01-10')] });

    const [cost] = costSchedule(s.schedule, ctx()).assignments;
    expect(cost?.total).toBe(72);
    expect(lineAmounts(cost!)).toEqual({ on_call: 72 });
  });

  it('prices an on-call multiplier against the base rate', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, ON_CALL, '2026-01-07')] });

    const [cost] = costSchedule(
      s.schedule,
      ctx({ differentials: [diff('on_call', 'multiplier', 0.25)] }),
    ).assignments;
    expect(cost?.total).toBe(144); // 12 × 48 × 0.25
  });

  it('charges the agency premium only for agency nurses', () => {
    const staff = makeNurse();
    const agency = makeNurse({ employmentType: 'agency', contractedHoursPerPeriod: 0 });
    const agencyRate: PayRate = {
      id: 'rate-agency',
      nurseId: agency.id,
      role: null,
      hourlyRate: 95,
      effectiveFrom: isoDate('2025-01-01'),
    };
    const s = scenario({
      nurses: [staff, agency],
      assignments: [
        assign(staff.id, DAY_12, '2026-01-05'),
        assign(agency.id, DAY_12, '2026-01-05'),
      ],
    });

    const report = costSchedule(s.schedule, ctx({ payRates: [RN_RATE, agencyRate] }));
    const staffCost = report.assignments.find((a) => a.nurseId === staff.id);
    const agencyCost = report.assignments.find((a) => a.nurseId === agency.id);
    expect(staffCost?.total).toBe(576);
    expect(agencyCost?.total).toBe(1425); // 12 × 95 × 1.25
    expect(lineAmounts(agencyCost!)).toEqual({ base: 1140, agency: 285 });
  });

  it('leaves a nurse with no rate unpriced rather than silently pricing them at zero', () => {
    const cna = makeNurse({ role: 'CNA' });
    const s = scenario({ nurses: [cna], assignments: [assign(cna.id, DAY_12, '2026-01-05')] });

    const report = costSchedule(s.schedule, ctx());
    expect(report.assignments[0]?.rateSource).toBe('none');
    expect(report.assignments[0]?.total).toBe(0);
    expect(report.unpricedAssignments).toBe(1);
    expect(report.unpricedNurseIds).toEqual([cna.id]);
    expect(report.nurses[0]?.unpricedAssignments).toBe(1);
  });
});

describe('overtime', () => {
  it('weekly: the fourth twelve of the week carries the eight hours past forty', () => {
    const nurse = makeNurse();
    // Mon–Thu of the same work week: 12, 24, 36, 48 cumulative hours.
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8]);
    expect(report.assignments[3]?.total).toBe(768); // 576 + 8h × $48 × 0.5
    expect(report.totals.overtimePremium).toBe(192);
    expect(report.totals.total).toBe(2496);
  });

  it('weekly: hours carried in from the previous period count toward the threshold', () => {
    const nurse = makeNurse();
    // Contract week runs Thursday–Wednesday, so Thu 1 – Sat 3 Jan (36h, last period) and
    // Monday 5 Jan (this period) share a week. The Monday shift is the one past forty.
    const s = scenario({
      nurses: [nurse],
      priorAssignments: ['2026-01-01', '2026-01-02', '2026-01-03'].map((d) =>
        assign(nurse.id, DAY_12, d, { periodId: 'period-0' }),
      ),
      assignments: [assign(nurse.id, DAY_12, '2026-01-05')],
    });

    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40], workWeekStartsOn: 4 }),
    );
    // Only this period's shift is priced; the tail is context, not a cost.
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]?.overtimeHours).toBe(8);
    expect(report.totals.total).toBe(768);
  });

  it('weekly: shifts in a new week start again from zero', () => {
    const nurse = makeNurse();
    // Wed–Sat then Sunday: the Sunday opens a new week, so it is straight time.
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8, 0]);
  });

  it('daily: a twelve-hour shift against an eight-hour daily threshold carries four hours', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05'), assign(nurse.id, DAY_8, '2026-01-07')],
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [DAILY_8] }));
    expect(report.assignments[0]?.overtimeHours).toBe(4);
    expect(report.assignments[0]?.total).toBe(672); // 576 + 4 × 48 × 0.5
    expect(report.assignments[1]?.overtimeHours).toBe(0);
    expect(report.assignments[1]?.total).toBe(384);
  });

  it('an hour is overtime once: the larger of the daily and weekly premium wins per shift', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40, DAILY_8] }));
    // Shifts 1–3: daily gives 4h ($96) each; shift 4: weekly's 8h ($192) beats daily's 4h.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 8]);
    expect(report.totals.overtimePremium).toBe(480);
  });

  it('the overtime premium compounds on the night rate, not the bare base', () => {
    const nurse = makeNurse();
    // Mon–Thu nights: straight rate $52.50; 8 OT hours on the fourth earn half of that again.
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, NIGHT_12, d),
      ),
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    expect(report.assignments[3]?.total).toBe(840); // 630 + 8 × 52.5 × 0.5
    expect(report.totals.total).toBe(2730);
  });

  it('on-call standby hours neither count toward the threshold nor earn overtime', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, ON_CALL, '2026-01-08'),
        assign(nurse.id, DAY_12, '2026-01-09'),
      ],
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 8]);
    expect(report.assignments[3]?.total).toBe(72);
    expect(report.totals.total).toBe(2568); // 4 × 576 + 72 + 192
  });
});

describe('aggregates', () => {
  it('sums per nurse and for the unit, most expensive nurse first', () => {
    const a = makeNurse();
    const b = makeNurse();
    const s = scenario({
      nurses: [a, b],
      assignments: [
        assign(b.id, NIGHT_12, '2026-01-05'),
        assign(a.id, DAY_12, '2026-01-05'),
        assign(a.id, DAY_12, '2026-01-07'),
      ],
    });

    const report = costSchedule(s.schedule, ctx());
    expect(report.nurses.map((n) => n.nurseId)).toEqual([a.id, b.id]);
    expect(report.nurses[0]).toMatchObject({ assignments: 2, hours: 24, total: 1152 });
    expect(report.nurses[1]).toMatchObject({ assignments: 1, hours: 12, total: 630 });
    expect(report.totals).toMatchObject({
      hours: 36,
      base: 1728,
      differentials: 54,
      overtimePremium: 0,
      total: 1782,
    });
    expect(report.totals.byKind.night).toBe(54);
  });

  it('ranks overtime concentration by hours with each nurse’s share of the total', () => {
    const light = makeNurse();
    const heavy = makeNurse();
    const none = makeNurse();
    const week = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    const s = scenario({
      nurses: [light, heavy, none],
      assignments: [
        ...week.slice(0, 4).map((d) => assign(light.id, DAY_12, d)), // 48h → 8 OT
        ...week.map((d) => assign(heavy.id, DAY_12, d)), // 60h → 20 OT
        assign(none.id, DAY_12, '2026-01-05'),
      ],
    });

    const { overtime } = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    expect(overtime.totalHours).toBe(28);
    expect(overtime.ranked.map((r) => r.nurseId)).toEqual([heavy.id, light.id]);
    expect(overtime.ranked[0]?.share).toBeCloseTo(20 / 28);
    expect(overtime.ranked[0]?.premium).toBe(480); // 20 × 48 × 0.5
    expect(overtime.nursesWithOvertime).toBe(2);
    expect(overtime.topThreeShare).toBe(1);
    // Gini over [20, 8, 0] by hand: 80 / (2 · 3² · 28/3) = 0.476.
    expect(overtime.gini).toBeCloseTo(0.476, 3);
  });

  it('reports no concentration when nobody works overtime', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, DAY_12, '2026-01-05')] });

    const { overtime } = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    expect(overtime).toMatchObject({
      totalHours: 0,
      totalPremium: 0,
      ranked: [],
      nursesWithOvertime: 0,
      topThreeShare: 0,
      gini: 0,
    });
  });
});

describe('pricing a candidate assignment', () => {
  function candidate(nurseId: string, date: string): Assignment {
    return assign(nurseId, DAY_12, date, { id: 'candidate' });
  }

  it('prices a shift that tips the week into overtime with the overtime it triggers', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const result = marginalCost(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40] }),
      candidate(nurse.id, '2026-01-08'),
    );
    expect(result.cost.overtimeHours).toBe(8);
    expect(result.cost.total).toBe(768);
    expect(result.delta).toBe(768);
  });

  it('prices a shift in a fresh week at straight time', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const result = marginalCost(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40] }),
      candidate(nurse.id, '2026-01-12'),
    );
    expect(result.cost.total).toBe(576);
    expect(result.delta).toBe(576);
  });

  it('charges the overtime a shift causes even when it lands on a later shift', () => {
    const nurse = makeNurse();
    // Tue–Thu already scheduled; adding the Monday before them makes Thursday the shift
    // past forty. The candidate itself is straight time, but the nurse's week costs $192 more.
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const result = marginalCost(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40] }),
      candidate(nurse.id, '2026-01-05'),
    );
    expect(result.cost.overtimeHours).toBe(0);
    expect(result.cost.total).toBe(576);
    expect(result.delta).toBe(768);
  });

  it('does not disturb the schedule it was priced against', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, DAY_12, '2026-01-05')] });

    marginalCost(s.schedule, ctx(), candidate(nurse.id, '2026-01-06'));
    expect(s.schedule.assignments()).toHaveLength(1);
  });
});

describe('budget', () => {
  it('reports how far over or under the period landed', () => {
    expect(compareToBudget(52_000, 50_000)).toEqual({
      targetDollars: 50_000,
      actualDollars: 52_000,
      variance: 2_000,
      ratio: 1.04,
    });
  });

  it('has no ratio against a zero budget', () => {
    expect(compareToBudget(1_000, 0).ratio).toBeNull();
  });
});
