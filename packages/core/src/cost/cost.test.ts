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
  differential,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  scenario,
  testUnit,
  UNIT_ID,
} from '../testing/fixtures.js';
import { compareToBudget, costSchedule, hoursInDailyWindow, marginalCost } from './cost.js';
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

  it('pays Christmas at the major-holiday premium instead of the holiday one', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, DAY_12, '2026-12-25')] });

    // Friday 25 December, a major holiday: $48 × 2 for 12 hours, and no 1.5× on top.
    const [cost] = costSchedule(
      s.schedule,
      ctx({
        differentials: [HOLIDAY, diff('major_holiday', 'multiplier', 2)],
        holidayDates: new Set([isoDate('2026-12-25')]),
        majorHolidayDates: new Set([isoDate('2026-12-25')]),
      }),
    ).assignments;
    expect(lineAmounts(cost!)).toEqual({ base: 576, major_holiday: 576 });
    expect(cost?.total).toBe(1152);
  });

  it('keeps a minor holiday at the holiday premium when majors pay more', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, DAY_12, '2026-01-19')] });

    // Monday 19 January (MLK Day), minor: $48 × 1.5 for 12 hours.
    const [cost] = costSchedule(
      s.schedule,
      ctx({
        differentials: [HOLIDAY, diff('major_holiday', 'multiplier', 2)],
        holidayDates: new Set([isoDate('2026-01-19'), isoDate('2026-12-25')]),
        majorHolidayDates: new Set([isoDate('2026-12-25')]),
      }),
    ).assignments;
    expect(lineAmounts(cost!)).toEqual({ base: 576, holiday: 288 });
  });

  it('pays a major holiday the holiday premium when no major premium is set', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, DAY_12, '2026-12-25')] });

    const [cost] = costSchedule(
      s.schedule,
      ctx({
        holidayDates: new Set([isoDate('2026-12-25')]),
        majorHolidayDates: new Set([isoDate('2026-12-25')]),
      }),
    ).assignments;
    expect(lineAmounts(cost!)).toEqual({ base: 576, holiday: 288 });
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

  it('still counts the 4 hours past 8 as overtime for a nurse with no rate, at $0', () => {
    const cna = makeNurse({ role: 'CNA' });
    const s = scenario({ nurses: [cna], assignments: [assign(cna.id, DAY_12, '2026-01-05')] });

    const [cost] = costSchedule(s.schedule, ctx({ overtimeRules: [DAILY_8] })).assignments;
    expect(cost?.rateSource).toBe('none');
    expect(cost?.overtimeHours).toBe(4);
    expect(cost?.total).toBe(0);
    expect(cost?.lines).toEqual([]);
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

  it('weekly: a PTO day that counts toward overtime uses up the threshold first', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });
    const overtimeLeave = new Map([
      [nurse.id, [{ nurseId: nurse.id, date: isoDate('2026-01-08'), hours: 12 }]],
    ]);

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40], overtimeLeave }));
    // 12h leave, then 24, 36, 48: the Wednesday is the shift that crosses forty.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 8]);
  });
});

describe('California overtime: by workday, banded, and the seventh day', () => {
  // Labor Code § 510: past 8 hours in a workday at 1.5×, past 12 at 2×; on the seventh
  // consecutive day of a workweek, the first 8 hours at 1.5× and the rest at 2×.
  const DAILY_8_HALF: OvertimeRule = { ...DAILY_8, id: 'ot-ca-8' };
  const DAILY_12_DOUBLE: OvertimeRule = {
    ...DAILY_8,
    id: 'ot-ca-12',
    thresholdHours: 12,
    multiplier: 2,
  };
  const SEVENTH_HALF: OvertimeRule = {
    ...DAILY_8,
    id: 'ot-ca-7th',
    basis: 'seventh_day',
    thresholdHours: 0,
  };
  const SEVENTH_DOUBLE: OvertimeRule = {
    ...DAILY_8,
    id: 'ot-ca-7th-8',
    basis: 'seventh_day',
    thresholdHours: 8,
    multiplier: 2,
  };
  const CA_DAILY = [DAILY_8_HALF, DAILY_12_DOUBLE];
  const DAY_13 = {
    ...DAY_12,
    id: 'st-d13',
    name: 'Day 13',
    abbreviation: 'D13',
    durationHours: 13,
  };

  it('pays a 13-hour shift 8 straight, 4 at time and a half and 1 at double time', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, DAY_13],
      assignments: [assign(nurse.id, DAY_13, '2026-01-05')],
    });
    const [cost] = costSchedule(s.schedule, ctx({ overtimeRules: CA_DAILY })).assignments;
    expect(cost?.overtimeHours).toBe(5);
    // 13 × $48 = $624; 4 × $24 = $96 at time and a half; 1 × $48 = $48 at double time.
    expect(cost?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 4, rate: 24, amount: 96 },
      { kind: 'overtime', hours: 1, rate: 48, amount: 48 },
    ]);
    expect(cost?.total).toBe(768);
  });

  it('counts a double by the workday: the second eight of a sixteen-hour day is all premium', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8, EVENING_8],
      assignments: [
        assign(nurse.id, DAY_8, '2026-01-05'),
        assign(nurse.id, EVENING_8, '2026-01-05'),
      ],
    });
    const report = costSchedule(s.schedule, ctx({ overtimeRules: CA_DAILY }));
    // The day shift is hours 0–8 of the workday; the evening is 8–16: 4 at 1.5×, 4 at 2×.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 8]);
    expect(report.totals.overtimePremium).toBe(4 * 24 + 4 * 48);
  });

  it('keeps a night across midnight in the workday it started on', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-05')],
    });
    const [cost] = costSchedule(s.schedule, ctx({ overtimeRules: CA_DAILY })).assignments;
    // One 12-hour workday: 4 hours past eight at half the $52.50 night rate again.
    expect(cost?.overtimeHours).toBe(4);
    expect(cost?.total).toBe(630 + 4 * 26.25);
  });

  it('pays the seventh straight day of the workweek at premium from its first hour', () => {
    const nurse = makeNurse();
    // Sun 4 Jan to Fri 9 Jan, six eights; Saturday 10 Jan a twelve, the seventh day in a row.
    const days = [
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
    ];
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8, DAY_12],
      assignments: [
        ...days.map((d) => assign(nurse.id, DAY_8, d)),
        assign(nurse.id, DAY_12, '2026-01-10'),
      ],
    });
    const report = costSchedule(s.schedule, ctx({ overtimeRules: [SEVENTH_HALF, SEVENTH_DOUBLE] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 0, 12]);
    // Saturday earns the $3 weekend differential, so the straight rate is $51: 8 × $25.50 at
    // time and a half, then 4 × $51 at double time.
    expect(report.totals.overtimePremium).toBe(8 * 25.5 + 4 * 51);
  });

  it('does not treat a seventh shift as the seventh day when the week had a day off', () => {
    const nurse = makeNurse();
    // Mon 5 to Sat 10 Jan is six days in a row, but Sunday 4 Jan, the week's first, was off.
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8],
      assignments: [
        '2026-01-05',
        '2026-01-06',
        '2026-01-07',
        '2026-01-08',
        '2026-01-09',
        '2026-01-10',
      ].map((d) => assign(nurse.id, DAY_8, d)),
    });
    const report = costSchedule(s.schedule, ctx({ overtimeRules: [SEVENTH_HALF, SEVENTH_DOUBLE] }));
    expect(report.totals.overtimeHours).toBe(0);
  });

  it('pays each hour once, at the highest rate any rule gives it', () => {
    const nurse = makeNurse();
    // Mon–Wed twelves, Thu a thirteen: weekly 40 makes the Thursday's last 9 hours overtime at
    // 1.5×; the daily rules make hours 8–12 1.5× and hour 13 2×. Per hour, the highest wins:
    // hours 4–12 at 1.5× (8 hours) and hour 13 at 2×.
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, DAY_13],
      assignments: [
        ...['2026-01-05', '2026-01-06', '2026-01-07'].map((d) => assign(nurse.id, DAY_12, d)),
        assign(nurse.id, DAY_13, '2026-01-08'),
      ],
    });
    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40, ...CA_DAILY] }));
    // Mon–Wed: 4 hours past eight each at 1.5×.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 9]);
    expect(report.assignments[3]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 8, rate: 24, amount: 192 },
      { kind: 'overtime', hours: 1, rate: 48, amount: 48 },
    ]);
  });
});

describe('overtime over the pay period', () => {
  // Six 12s and an 8 over the Sun 4 – Sat 17 Jan pay period, all on weekdays: 44h the first
  // week, 36h the second, 80h in all.
  const PAY_PERIOD_80: OvertimeRule = {
    id: 'ot-pay-period',
    unitId: UNIT_ID,
    basis: 'pay_period',
    thresholdHours: 80,
    multiplier: 1.5,
    active: true,
  };
  const fortnight = (nurseId: string) => [
    assign(nurseId, DAY_12, '2026-01-05'),
    assign(nurseId, DAY_12, '2026-01-07'),
    assign(nurseId, DAY_12, '2026-01-08'),
    assign(nurseId, DAY_8, '2026-01-09'),
    assign(nurseId, DAY_12, '2026-01-12'),
    assign(nurseId, DAY_12, '2026-01-14'),
    assign(nurseId, DAY_12, '2026-01-15'),
  ];

  it('prices the 44-hour week at straight time when the fortnight comes to 80', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: fortnight(nurse.id) });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [PAY_PERIOD_80] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(report.totals.total).toBe(3840); // 6 × 576 + 384

    // The same fortnight under a weekly rule: the Friday 8 takes week one to 44h.
    const weekly = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    expect(weekly.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 4, 0, 0, 0]);
  });

  it('charges the hours past 80 to the shift that crosses it', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [...fortnight(nurse.id), assign(nurse.id, DAY_12, '2026-01-16')],
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [PAY_PERIOD_80] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 0, 0, 12]);
    expect(report.assignments[7]?.total).toBe(864); // 576 + 12 × 48 × 0.5
  });

  it('counts hours from the previous schedule in the same pay period', () => {
    const nurse = makeNurse();
    // This schedule starts Sun 11 Jan, halfway through the pay period.
    const [w1, w2] = [fortnight(nurse.id).slice(0, 4), fortnight(nurse.id).slice(4)];
    const s = scenario({
      nurses: [nurse],
      startDate: isoDate('2026-01-11'),
      endDate: isoDate('2026-01-24'),
      priorAssignments: w1.map((a) => ({ ...a, periodId: 'period-0' })),
      assignments: [...w2, assign(nurse.id, DAY_12, '2026-01-16')],
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [PAY_PERIOD_80] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 12]);
  });

  it('starts a pay period that counts leave toward overtime with the leave', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: fortnight(nurse.id) });
    const overtimeLeave = new Map([
      [nurse.id, [{ nurseId: nurse.id, date: isoDate('2026-01-13'), hours: 12 }]],
    ]);

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [PAY_PERIOD_80], overtimeLeave }));
    // 12h leave first, then 24 … 80 by Wed 14th; Thu 15th takes it to 92.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 0, 12]);
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

describe('night and evening differentials by the clock', () => {
  // $50/h; night 10% for 18:00-06:00, the whole tour once 4 hours fall in it (38 U.S.C. 7453(b)).
  const NIGHT_WINDOW = { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 4 };
  const night10 = {
    ...differential('night', 'multiplier', 1.1),
    window: NIGHT_WINDOW,
  };
  const EVENING_1530 = {
    id: 'st-e-1530',
    unitId: UNIT_ID,
    name: 'Evening 15:30',
    abbreviation: 'E15',
    startTime: '15:30',
    durationHours: 8.5,
    isNight: false,
    isOnCall: false,
    color: '#f97316',
    sortOrder: 9,
    active: true,
    withinShiftTypeId: null,
  };

  // 1.1 - 1 is not exactly 0.1 in floating point; cents are what a payslip shows.
  const cents = (amounts: Record<string, number>) =>
    Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, Math.round(v * 100) / 100]));

  function priced(
    shiftType: typeof DAY_12,
    differentials: Differential[],
    overtimeRules: OvertimeRule[] = [],
  ) {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [shiftType],
      assignments: [assign(nurse.id, shiftType, '2026-01-05')],
    });
    const costs = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(50)], differentials, overtimeRules }),
    );
    return costs.assignments.find((c) => c.date === isoDate('2026-01-05'))!;
  }

  it('pays a 19:00-07:00 night on every hour because 11 of them fall in the window', () => {
    const cost = priced(NIGHT_12, [night10]);
    expect(cents(lineAmounts(cost))).toEqual({ base: 600, night: 60 });
    expect(cost.straightRate).toBeCloseTo(55);
  });

  it('pays a 07:00-19:00 day shift the night differential for its one evening hour only', () => {
    const cost = priced(DAY_12, [night10]);
    expect(cents(lineAmounts(cost))).toEqual({ base: 600, night: 5 });
    expect(cost.lines.find((l) => l.kind === 'night')?.hours).toBe(1);
    expect(cost.total).toBeCloseTo(605);
    expect(cost.straightRate).toBe(50);
  });

  it('pays a 15:30-24:00 evening tour on every hour because 6 of them fall in the window', () => {
    const cost = priced(EVENING_1530, [night10]);
    expect(cents(lineAmounts(cost))).toEqual({ base: 425, night: 42.5 });
  });

  it('pays a 07:00-15:00 day shift no night differential', () => {
    const cost = priced(DAY_8, [night10]);
    expect(cost.lines.map((l) => l.kind)).toEqual(['base']);
  });

  it('ignores the night flag on the shift type once the differential has a window', () => {
    const flagged = { ...DAY_8, isNight: true };
    expect(priced(flagged, [night10]).lines.map((l) => l.kind)).toEqual(['base']);
  });

  it('still goes by the night flag when the differential has no window', () => {
    const plain = differential('night', 'multiplier', 1.1);
    expect(cents(lineAmounts(priced(NIGHT_12, [plain])))).toEqual({ base: 600, night: 60 });
    expect(priced(DAY_12, [plain]).lines.map((l) => l.kind)).toEqual(['base']);
  });

  it('pays an evening differential for the hours inside its window', () => {
    const evening = {
      ...differential('evening', 'flat', 2),
      window: { startTime: '15:00', endTime: '23:00', wholeShiftAtHours: null },
    };
    expect(lineAmounts(priced(EVENING_8, [evening]))).toEqual({ base: 400, evening: 16 });
    expect(lineAmounts(priced(DAY_12, [evening]))).toEqual({ base: 600, evening: 8 });
  });

  it('pays an evening differential with no window nothing', () => {
    const evening = differential('evening', 'flat', 2);
    expect(priced(EVENING_8, [evening]).lines.map((l) => l.kind)).toEqual(['base']);
  });

  it('does not let the one evening hour of a day shift raise its overtime rate', () => {
    // 07:00-19:00 with daily overtime past 8h: 4 overtime hours at half of the $50 base.
    const withPartial = priced(DAY_12, [night10], [DAILY_8]);
    const without = priced(DAY_12, [], [DAILY_8]);
    const ot = (c: typeof withPartial) => c.lines.find((l) => l.kind === 'overtime')!;
    expect(ot(without).rate).toBe(25);
    expect(ot(withPartial).rate).toBe(25);
    expect(withPartial.total).toBeCloseTo(705); // 600 base + 5 night + 4 x 25 overtime
  });

  it('gives a night that starts as the evening window closes no evening hours', () => {
    // 23:00-07:00 against 15:00-23:00: the window's end is half-open, so the first minute misses.
    const start = 5 * 1440 + 23 * 60;
    expect(
      hoursInDailyWindow(
        { startMinute: start, endMinute: start + 480 },
        { startTime: '15:00', endTime: '23:00' },
      ),
    ).toBe(0);
  });

  it('treats a window whose start equals its end as the whole day', () => {
    const start = 5 * 1440 + 7 * 60;
    expect(
      hoursInDailyWindow(
        { startMinute: start, endMinute: start + 720 },
        { startTime: '00:00', endTime: '00:00' },
      ),
    ).toBe(12);
  });

  it('counts the hours of a window that wraps midnight on every day a shift touches', () => {
    const min = (d: number, hhmm: number) => d * 1440 + hhmm;
    const daily = { startTime: '18:00', endTime: '06:00' };
    // 19:00 Mon to 07:00 Tue: 18:00-06:00 covers 19:00-24:00 and 00:00-06:00 = 11h.
    expect(
      hoursInDailyWindow({ startMinute: min(5, 1140), endMinute: min(5, 1140) + 720 }, daily),
    ).toBe(11);
    // 07:00-15:00 misses it entirely.
    expect(hoursInDailyWindow({ startMinute: min(5, 420), endMinute: min(5, 900) }, daily)).toBe(0);
  });
});

describe('overtime beyond the scheduled tour and past consecutive hours', () => {
  // Base rate $50, no differentials, so every figure is hours × $50 (premium at 0.5 × $50 = $25).
  const rn50 = { payRates: [{ ...RN_RATE, hourlyRate: 50 }], differentials: [] };
  const beyondTour = (thresholdHours: number): OvertimeRule => ({
    id: 'ot-tour',
    unitId: UNIT_ID,
    basis: 'beyond_scheduled_tour',
    thresholdHours,
    multiplier: 1.5,
    active: true,
  });
  const consecutive = (thresholdHours: number): OvertimeRule => ({
    ...beyondTour(thresholdHours),
    id: 'ot-consecutive',
    basis: 'consecutive',
  });

  it('pays the hour a nurse is held past her 8-hour tour at time and a half', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_8, '2026-01-05', { holdoverMinutes: 60 })],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [beyondTour(0)] }));
    expect(report.assignments[0]?.overtimeHours).toBe(1);
    expect(report.assignments[0]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 1, rate: 25, amount: 25 },
    ]);
    expect(report.totals.total).toBe(475); // 9h × $50 + $25
  });

  it('pays no overtime for a tour worked to its scheduled end', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: [assign(nurse.id, DAY_8, '2026-01-05')] });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [beyondTour(0)] }));
    expect(report.assignments[0]?.lines.some((l) => l.kind === 'overtime')).toBe(false);
    expect(report.totals.total).toBe(400);
  });

  it('forgives a ten-minute stay under a fifteen-minute grace but pays an hour past it', () => {
    const nurse = makeNurse();
    const rules = ctx({ ...rn50, overtimeRules: [beyondTour(0.25)] });
    const brief = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_8, '2026-01-05', { holdoverMinutes: 10 })],
    });
    expect(costSchedule(brief.schedule, rules).assignments[0]?.overtimeHours).toBe(0);

    const hour = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_8, '2026-01-05', { holdoverMinutes: 60 })],
    });
    // 8h15 into the shift to 9h: 0.75 hours of overtime.
    expect(costSchedule(hour.schedule, rules).assignments[0]?.overtimeHours).toBe(0.75);
  });

  it('makes the last four hours of a 12 overtime after eight consecutive hours', () => {
    const nurse = makeNurse();
    // A second 12 two days on is its own stretch: each is four hours over, not one 24h week.
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05'), assign(nurse.id, DAY_12, '2026-01-07')],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [consecutive(8)] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([4, 4]);
    expect(report.totals.overtimePremium).toBe(200); // 8h × $25
  });

  it('makes a whole evening shift overtime when it follows the day shift straight on', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8, EVENING_8],
      assignments: [
        assign(nurse.id, DAY_8, '2026-01-05'),
        assign(nurse.id, EVENING_8, '2026-01-05'),
      ],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [consecutive(8)] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 8]);
  });

  it('pays a held-over hour once when a pay-period rule and a tour rule both reach it', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 60 })],
    });
    const periodRule: OvertimeRule = {
      ...beyondTour(80),
      id: 'ot-pp',
      basis: 'pay_period',
    };
    const report = costSchedule(
      s.schedule,
      ctx({ ...rn50, overtimeRules: [periodRule, beyondTour(0)] }),
    );
    expect(report.assignments[0]?.overtimeHours).toBe(1);
    expect(report.totals.overtimePremium).toBe(25);
  });

  it('does not count on-call standby as hours worked toward consecutive overtime', () => {
    const nurse = makeNurse();
    const standby = { ...ON_CALL, startTime: '15:00' };
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8, standby],
      assignments: [assign(nurse.id, DAY_8, '2026-01-05'), assign(nurse.id, standby, '2026-01-05')],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [consecutive(8)] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0]);
    expect(report.assignments.some((a) => a.lines.some((l) => l.kind === 'overtime'))).toBe(false);
  });

  it('counts a holdover that runs into the next shift once: 16 hours on the clock, not 16.5', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8, EVENING_8],
      assignments: [
        assign(nurse.id, DAY_8, '2026-01-05', { holdoverMinutes: 30 }),
        assign(nurse.id, EVENING_8, '2026-01-05'),
      ],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [consecutive(8)] }));
    // The held-over half hour is past eight; the evening starts with eight already on the clock
    // (07:00 to 15:00), so all 8 of its hours are overtime, from hour 0.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0.5, 8]);
  });

  it('pays held-over hours at the higher of the tour and daily rules, as one band', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_8, '2026-01-05', { holdoverMinutes: 120 })],
    });
    const double: OvertimeRule = { ...beyondTour(0), id: 'ot-tour-2x', multiplier: 2 };
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [double, DAILY_8] }));
    // 10h worked; the daily rule and the tour rule both start at hour 8, and 2× wins.
    expect(report.assignments[0]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 2, rate: 50, amount: 100 },
    ]);
  });

  it('never prices last period’s shift as consecutive overtime', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      priorAssignments: [assign(nurse.id, DAY_12, '2026-01-03', { periodId: 'period-0' })],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05')],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [consecutive(8)] }));
    expect(report.assignments).toHaveLength(1);
    // Only this period's own 12 is judged, from its own start: four hours past eight.
    expect(report.assignments[0]?.overtimeHours).toBe(4);
    expect(report.totals.overtimePremium).toBe(100);
  });

  it('counts last period’s hours already on the clock but only prices this period’s', () => {
    const nurse = makeNurse();
    // Night 19:00 Jan 4 – 07:00 Jan 5 (prior), then this period's day 07:00 Jan 5: 12h already
    // worked, so all of the day shift is overtime and none of the night is priced.
    const s = scenario({
      nurses: [nurse],
      priorAssignments: [assign(nurse.id, NIGHT_12, '2026-01-04', { periodId: 'period-0' })],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05')],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [consecutive(8)] }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([12]);
  });
});

describe('California and UC overtime: daily premium hours do not pyramid into weekly', () => {
  // Cal. Lab. Code § 510 / DLSE: hours already paid at a daily premium are not counted again
  // toward the weekly 40; UC–CNA Art. 14 §M credits daily overtime toward the 80.
  const WEEKLY_40_NO_PYRAMID: OvertimeRule = { ...WEEKLY_40, pyramiding: 'none' };
  const DAILY_12_DOUBLE = overtimeRule('daily', 12, 2);
  const DAY_13 = {
    ...DAY_12,
    id: 'st-d13',
    name: 'Day 13',
    abbreviation: 'D13',
    durationHours: 13,
  };
  const DAY_9 = { ...DAY_8, id: 'st-d9', name: 'Day 9', abbreviation: 'D9', durationHours: 9 };
  const monToThu = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];

  it('pays a four-twelve week four hours of daily overtime a shift and nothing weekly on top', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: monToThu.map((d) => assign(nurse.id, DAY_12, d)),
    });
    // Straight hours are 8 a shift: 32 for the week, short of 40, so only the daily 4s remain.
    const none = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40_NO_PYRAMID, DAILY_8] }));
    expect(none.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 4]);
    expect(none.totals.overtimePremium).toBe(384); // 16h × $24

    const stacked = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40, DAILY_8] }));
    expect(stacked.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 8]);
  });

  it('pays a thirteen at the end of a California week by the day alone', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, DAY_13],
      assignments: [
        ...monToThu.slice(0, 3).map((d) => assign(nurse.id, DAY_12, d)),
        assign(nurse.id, DAY_13, '2026-01-08'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40_NO_PYRAMID, DAILY_8, DAILY_12_DOUBLE] }),
    );
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 5]);
    expect(report.assignments[3]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 4, rate: 24, amount: 96 },
      { kind: 'overtime', hours: 1, rate: 48, amount: 48 },
    ]);
  });

  it('counts only the straight hours of last period’s twelves toward this week’s forty', () => {
    const nurse = makeNurse();
    // The period starts Thu 8 Jan; Mon 5 – Wed 7 Jan were last period's twelves, 8 straight hours
    // each: 24 toward the forty. Thursday takes it to 32 and Friday to 40, so neither is weekly
    // overtime and each pays only its 4 daily hours.
    const s = scenario({
      nurses: [nurse],
      startDate: isoDate('2026-01-08'),
      priorAssignments: ['2026-01-05', '2026-01-06', '2026-01-07'].map((d) =>
        assign(nurse.id, DAY_12, d, { periodId: 'period-0' }),
      ),
      assignments: [assign(nurse.id, DAY_12, '2026-01-08'), assign(nurse.id, DAY_12, '2026-01-09')],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40_NO_PYRAMID, DAILY_8] }),
    );
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([4, 4]);
  });

  it('ignores a pyramiding setting on a daily rule', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: monToThu.map((d) => assign(nurse.id, DAY_12, d)),
    });
    // Only weekly and pay-period rules can be told not to pyramid; a daily 8 still pays each
    // twelve its last 4 hours, with or without the setting.
    const dailyNone = overtimeRule('daily', 8, 1.5, { pyramiding: 'none' });
    const withSetting = costSchedule(s.schedule, ctx({ overtimeRules: [dailyNone] }));
    const without = costSchedule(s.schedule, ctx({ overtimeRules: [DAILY_8] }));
    expect(withSetting.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 4]);
    expect(without.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 4]);
  });

  it('makes the sixth eight of the week weekly overtime, counted once', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8],
      assignments: [
        '2026-01-05',
        '2026-01-06',
        '2026-01-07',
        '2026-01-08',
        '2026-01-09',
        '2026-01-10',
      ].map((d) => assign(nurse.id, DAY_8, d)),
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40_NO_PYRAMID, DAILY_8] }),
    );
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 8]);
  });

  it('a UC eight-hour nurse’s daily overtime counts toward the eighty', () => {
    const nurse = makeNurse();
    const PAY_PERIOD_80_NO_PYRAMID = overtimeRule('pay_period', 80, 1.5, { pyramiding: 'none' });
    // Ten eights (80 straight hours) in the Sun 4 – Sat 17 Jan pay period, then a nine on Fri 16:
    // its ninth hour is daily overtime, and its first eight are past the 80.
    const eights = [
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-12',
      '2026-01-13',
      '2026-01-14',
      '2026-01-15',
    ];
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8, DAY_9],
      assignments: [
        ...eights.map((d) => assign(nurse.id, DAY_8, d)),
        assign(nurse.id, DAY_9, '2026-01-16'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [PAY_PERIOD_80_NO_PYRAMID, DAILY_8] }),
    );
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9,
    ]);
    expect(report.nurses[0]?.overtimeHours).toBe(9);
  });
});

describe('a minimum on weekly overtime that does not pyramid', () => {
  // Weekly 40 at 1.5× with a one-hour minimum, not counting daily premium hours, beside daily 8.
  const WEEKLY_40_MIN_HOUR = overtimeRule('weekly', 40, 1.5, {
    pyramiding: 'none',
    minimumMinutes: 60,
  });
  const WEEKLY_40_NO_MINIMUM = overtimeRule('weekly', 40, 1.5, { pyramiding: 'none' });
  const rules = [WEEKLY_40_MIN_HOUR, DAILY_8];
  const monToThu = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];

  function week(nurseId: string, extra: Assignment[]) {
    return scenario({
      nurses: [makeNurse({ id: nurseId })],
      shiftTypes: [DAY_8, DAY_12],
      assignments: [...monToThu.map((d) => assign(nurseId, DAY_8, d)), ...extra],
    });
  }

  it('pays a Friday twelve only its daily hours when the week’s straight time comes to forty', () => {
    // 32 straight Mon–Thu, Friday's first 8 make 40: no weekly overtime, 4 daily hours.
    const s = week('n', [assign('n', DAY_12, '2026-01-09')]);
    const report = costSchedule(s.schedule, ctx({ overtimeRules: rules }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 4]);
  });

  it('pays a Saturday twelve after a forty-hour week overtime from its first hour', () => {
    // 40 straight by Friday; Saturday's 8 straight hours are all past forty (8h ≥ the 1h
    // minimum), and hours 8–12 are daily overtime: 12 hours at 1.5×.
    const s = week('n', [assign('n', DAY_8, '2026-01-09'), assign('n', DAY_12, '2026-01-10')]);
    const report = costSchedule(s.schedule, ctx({ overtimeRules: rules }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0, 0, 12]);
  });

  it('leaves a half hour held over on Friday to the daily rule', () => {
    // Friday 8h30 under daily 8: the half hour is daily overtime, so Friday's straight hours are
    // 8 and the week's 40: no weekly overtime either way, and the daily half hour is paid.
    const s = week('n', [assign('n', DAY_8, '2026-01-09', { holdoverMinutes: 30 })]);
    const withMinimum = costSchedule(s.schedule, ctx({ overtimeRules: rules }));
    expect(withMinimum.assignments[4]?.overtimeHours).toBe(0.5);
    const noMinimum = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [WEEKLY_40_NO_MINIMUM, DAILY_8] }),
    );
    expect(noMinimum.assignments[4]?.overtimeHours).toBe(0.5);
  });

  it('drops half an hour of weekly overtime under the hour minimum, keeping the daily four', () => {
    // Half an hour of paid leave counted toward overtime opens the week, so Mon–Thu reach 32.5
    // and Friday's 8 straight hours 40.5: weekly overtime is the half hour before hour 8, under
    // the one-hour minimum, so Friday pays only daily hours 8–12. Without the minimum, 4.5.
    const s = week('n', [assign('n', DAY_12, '2026-01-09')]);
    const overtimeLeave = new Map([
      ['n', [{ nurseId: 'n', date: isoDate('2026-01-05'), hours: 0.5 }]],
    ]);
    const withMinimum = costSchedule(s.schedule, ctx({ overtimeRules: rules, overtimeLeave }));
    expect(withMinimum.assignments[4]?.overtimeHours).toBe(4);
    const noMinimum = costSchedule(
      s.schedule,
      ctx({
        overtimeRules: [WEEKLY_40_NO_MINIMUM, DAILY_8],
        overtimeLeave,
      }),
    );
    expect(noMinimum.assignments[4]?.overtimeHours).toBe(4.5);
  });
});

describe('double time on a day beyond the regularly scheduled workdays', () => {
  // IWC Wage Order 5 § 3(B)(8): on a health-care alternative workweek, hours past 8 on a day
  // beyond the regularly scheduled workdays are paid at double time.
  const EXTRA_DAY_8_DOUBLE = overtimeRule('beyond_scheduled_days', 8, 2);
  const DAILY_12_DOUBLE = overtimeRule('daily', 12, 2);
  const rules = [EXTRA_DAY_8_DOUBLE, WEEKLY_40, DAILY_12_DOUBLE];
  const monToThu = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];

  it('pays a three-twelve nurse’s fourth day double time past eight', () => {
    const nurse = makeNurse({ scheduledDaysPerWeek: 3 });
    const s = scenario({
      nurses: [nurse],
      assignments: monToThu.map((d) => assign(nurse.id, DAY_12, d)),
    });
    const report = costSchedule(s.schedule, ctx({ overtimeRules: rules }));
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8]);
    // Hours 0–4 straight, 4–8 past forty at 1.5×, 8–12 on the extra day at 2×.
    expect(report.assignments[3]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 4, rate: 24, amount: 96 },
      { kind: 'overtime', hours: 4, rate: 48, amount: 192 },
    ]);
  });

  it('pays a nurse with no scheduled days on file only the weekly overtime', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: monToThu.map((d) => assign(nurse.id, DAY_12, d)),
    });
    const report = costSchedule(s.schedule, ctx({ overtimeRules: rules }));
    expect(report.assignments[3]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 8, rate: 24, amount: 192 },
    ]);
  });

  it('counts last period’s days toward the scheduled three but never prices them', () => {
    const nurse = makeNurse({ scheduledDaysPerWeek: 3 });
    // Contract week runs Thursday–Wednesday: Thu 1 – Sat 3 Jan (last period) are the three
    // scheduled days, so Monday 5 Jan is the fourth day worked.
    const s = scenario({
      nurses: [nurse],
      priorAssignments: ['2026-01-01', '2026-01-02', '2026-01-03'].map((d) =>
        assign(nurse.id, DAY_12, d, { periodId: 'period-0' }),
      ),
      assignments: [assign(nurse.id, DAY_12, '2026-01-05')],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [EXTRA_DAY_8_DOUBLE], workWeekStartsOn: 4 }),
    );
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 4, rate: 48, amount: 192 },
    ]);
  });
});

describe('premiums that add rather than compound', () => {
  // UC–CNA Art. 14 §N: no duplication, pyramiding or compounding of premiums; Title 38 pays each
  // differential as a percentage of basic pay. $50 base, night +$6, charge +$3.
  const differentials = [
    differential('night', 'flat', 6),
    differential('charge', 'flat', 3),
    differential('holiday', 'multiplier', 1.5),
  ];
  const DAILY_10_DOUBLE = overtimeRule('daily', 10, 2);

  function chargeNight(premiumStacking: CostContext['premiumStacking'], holiday: boolean) {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-05', { isCharge: true })],
    });
    return costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials,
        overtimeRules: [DAILY_10_DOUBLE],
        holidayDates: holiday ? new Set([isoDate('2026-01-05')]) : new Set(),
        ...(premiumStacking ? { premiumStacking } : {}),
      }),
    ).assignments[0]!;
  }

  it('pays the charge night’s two overtime hours double the base, not double the night rate', () => {
    // Straight rate $59 either way; compound overtime premium $59/h, additive $50/h.
    expect(chargeNight(undefined, false).total).toBe(826);
    expect(chargeNight('compound', false).total).toBe(826);
    const additive = chargeNight('additive', false);
    expect(additive.straightRate).toBe(59);
    expect(additive.total).toBe(808);
  });

  it('adds the holiday half-time on the base instead of on the night and charge rate', () => {
    const compound = chargeNight('compound', true);
    expect(compound.straightRate).toBe(88.5);
    expect(compound.total).toBe(1239);

    const additive = chargeNight('additive', true);
    expect(additive.straightRate).toBe(84);
    expect(additive.lines.find((l) => l.kind === 'holiday')?.rate).toBe(25);
    expect(additive.lines.find((l) => l.kind === 'overtime')?.rate).toBe(50);
    expect(additive.total).toBe(1108);
  });
});

describe('overtime too short to pay', () => {
  // VA: overtime of less than 15 minutes in a day is not paid. $50 base, no differentials.
  const rn50 = { payRates: [payRate(50)], differentials: [] };
  const consecutive8Min15 = overtimeRule('consecutive', 8, 1.5, { minimumMinutes: 15 });

  function heldOver(minutes: number, rule: OvertimeRule) {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_8, '2026-01-05', { holdoverMinutes: minutes })],
    });
    return costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [rule] })).assignments[0]!;
  }

  it('pays nothing extra for a ten-minute stay past an eight-hour tour', () => {
    expect(heldOver(10, consecutive8Min15).overtimeHours).toBe(0);
  });

  it('pays a quarter hour of overtime for a fifteen-minute stay', () => {
    expect(heldOver(15, consecutive8Min15).overtimeHours).toBe(0.25);
  });

  it('pays the ten minutes when the rule sets no minimum', () => {
    expect(heldOver(10, overtimeRule('consecutive', 8)).overtimeHours).toBeCloseTo(10 / 60);
  });

  it('still pays the ten minutes under the daily rule when only the consecutive rule has a minimum', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_8, '2026-01-05', { holdoverMinutes: 10 })],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ ...rn50, overtimeRules: [consecutive8Min15, DAILY_8] }),
    );
    // The minimum is judged per rule: the daily rule has none, so 8h10 pays 10 minutes over 8.
    expect(report.assignments[0]?.overtimeHours).toBeCloseTo(10 / 60);
  });

  it('counts a held-over stay too short to pay as straight time toward a California forty', () => {
    const nurse = makeNurse();
    // Mon–Fri eights, each held 10 minutes: 490 minutes a day, 2450 in the week. The 10 minutes
    // are under the consecutive rule's 15-minute minimum, so none of them is daily-style overtime
    // and all count as straight hours: 2450 − 2400 = 50 minutes past forty, all on Friday.
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_8],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map((d) =>
        assign(nurse.id, DAY_8, d, { holdoverMinutes: 10 }),
      ),
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        ...rn50,
        overtimeRules: [consecutive8Min15, { ...WEEKLY_40, pyramiding: 'none' }],
      }),
    );
    const hours = report.assignments.map((a) => a.overtimeHours);
    expect(hours.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(hours[4]).toBeCloseTo(50 / 60);
  });
});

describe('VA 72/80 and Baylor nurses on a unit with standard nurses', () => {
  // 38 U.S.C. § 7456A(c)(1): a 72/80 nurse is paid overtime past 36 hours in the administrative
  // workweek, past 12 on a tour day and past 8 on a day with no tour. § 7456(c)–(d): a Baylor nurse
  // is paid overtime past the tour, but no night, weekend or holiday pay for the tour itself.
  // $50 base throughout; 2026-01-05 is a Monday, 2026-01-09 a Friday, 2026-01-10 a Saturday.
  const rn50 = { payRates: [payRate(50)], differentials: [] };
  const WEEKLY_36_7280 = overtimeRule('weekly', 36, 1.5, { scheduleKinds: ['va_72_80'] });
  const threeTwelvesAndAnEight = (nurseId: string) => [
    assign(nurseId, DAY_12, '2026-01-05'),
    assign(nurseId, DAY_12, '2026-01-06'),
    assign(nurseId, DAY_12, '2026-01-07'),
    assign(nurseId, DAY_8, '2026-01-08'),
  ];

  it('pays a 72/80 nurse the eight hours past thirty-six on the week’s last shift', () => {
    const nurse = makeNurse({ scheduleKind: 'va_72_80' });
    const s = scenario({ nurses: [nurse], assignments: threeTwelvesAndAnEight(nurse.id) });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [WEEKLY_36_7280] }));
    // 36 straight hours from the three twelves; all 8 of Thursday's eight are past 36.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8]);
  });

  it('keeps a standard nurse on the same unit on the forty-hour week, not the 72/80 thirty-six', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse], assignments: threeTwelvesAndAnEight(nurse.id) });
    const report = costSchedule(
      s.schedule,
      ctx({ ...rn50, overtimeRules: [WEEKLY_40, WEEKLY_36_7280] }),
    );
    // 44 hours in the week: 4 past forty, never 8 past thirty-six.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 4]);
  });

  describe('a 72/80 nurse’s days with and without a tour', () => {
    const nurse = () => makeNurse({ scheduleKind: 'va_72_80' });
    // Monday's 12-hour tour and Wednesday's 8, each held over an hour.
    const heldOver = (nurseId: string) => [
      assign(nurseId, DAY_12, '2026-01-05', { holdoverMinutes: 60 }),
      assign(nurseId, DAY_8, '2026-01-07', { holdoverMinutes: 60 }),
    ];

    it('pays the hour past twelve on a tour day, and nothing on the 8 under the tour-day rule', () => {
      const n = nurse();
      const s = scenario({ nurses: [n], assignments: heldOver(n.id) });
      const rule = overtimeRule('daily', 12, 1.5, {
        tourDays: 'only',
        scheduleKinds: ['va_72_80'],
      });
      const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [rule] }));
      // 13 hours on the tour day: 1 past 12. The 9-hour non-tour day is not judged by this rule.
      expect(report.assignments.map((a) => a.overtimeHours)).toEqual([1, 0]);
    });

    it('pays the hour past eight on a day with no tour, and never judges the tour day by eight', () => {
      const n = nurse();
      const s = scenario({ nurses: [n], assignments: heldOver(n.id) });
      const rule = overtimeRule('daily', 8, 1.5, {
        tourDays: 'except',
        scheduleKinds: ['va_72_80'],
      });
      const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [rule] }));
      // The 9-hour day has no tour: 1 past 8. The 13-hour tour day is a tour day, so 0 here.
      expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 1]);
    });
  });

  describe('a Baylor nurse’s weekend tours', () => {
    const night = differential('night', 'multiplier', 1.1);
    const weekend = differential('weekend', 'multiplier', 1.25);
    const holiday = differential('holiday', 'multiplier', 2);

    it('pays a Baylor nurse’s Saturday night tour on a holiday at the base rate alone', () => {
      const saturdayHoliday = ctx({
        payRates: [payRate(50)],
        differentials: [night, weekend, holiday],
        holidayDates: new Set([isoDate('2026-01-10')]),
      });
      const baylor = makeNurse({ scheduleKind: 'va_baylor' });
      const b = scenario({
        nurses: [baylor],
        assignments: [assign(baylor.id, NIGHT_12, '2026-01-10')],
      });
      const [tour] = costSchedule(b.schedule, saturdayHoliday).assignments;
      expect(tour?.total).toBe(600); // 12h × $50, nothing else
      expect(tour?.lines.map((l) => l.kind)).toEqual(['base']);

      const standard = makeNurse();
      const s = scenario({
        nurses: [standard],
        assignments: [assign(standard.id, NIGHT_12, '2026-01-10')],
      });
      // $50 × 1.1 night × 1.25 weekend × 2 holiday = $137.50 an hour, × 12 = $1,650.
      expect(costSchedule(s.schedule, saturdayHoliday).assignments[0]?.total).toBeCloseTo(1650);
    });

    it('pays the hour a Baylor nurse is held past her tour its night and weekend pay', () => {
      const baylor = makeNurse({ scheduleKind: 'va_baylor' });
      const s = scenario({
        nurses: [baylor],
        assignments: [assign(baylor.id, NIGHT_12, '2026-01-10', { holdoverMinutes: 60 })],
      });
      const [cost] = costSchedule(
        s.schedule,
        ctx({
          payRates: [payRate(50)],
          differentials: [night, weekend],
          overtimeRules: [
            overtimeRule('beyond_scheduled_tour', 0, 1.5, { scheduleKinds: ['va_baylor'] }),
          ],
        }),
      ).assignments;
      // 13h × $50 = $650 base. The held-over hour earns night ($5) and weekend ($12.50) on the
      // base rate: they are kept out of the running rate, so the overtime premium is half of the
      // bare $50 ($25), not half of a night-and-weekend rate. 650 + 5 + 12.5 + 25 = 692.5.
      expect(cost?.lines.map((l) => [l.kind, l.hours])).toEqual([
        ['base', 13],
        ['night', 1],
        ['weekend', 1],
        ['overtime', 1],
      ]);
      const amounts = lineAmounts(cost!);
      expect(amounts.base).toBe(650);
      expect(amounts.night).toBeCloseTo(5);
      expect(amounts.weekend).toBeCloseTo(12.5);
      expect(amounts.overtime).toBe(25);
      expect(cost?.total).toBeCloseTo(692.5);
    });

    it('counts a Friday night running into Saturday as a Baylor tour, but not a Friday day', () => {
      // A weekend from Friday 00:00 and a night window of 18:00–06:00 (whole shift at 6 hours in
      // it): a Friday night is a night and weekend shift for everyone else, and so is a Friday day.
      const friday = ctx({
        payRates: [payRate(50)],
        differentials: [
          { ...night, window: { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 6 } },
          weekend,
          holiday,
        ],
        weekendDefinition: { ...DEFAULT_WEEKEND, startWeekday: 5, durationMinutes: 3 * 1440 },
        holidayDates: new Set([isoDate('2026-01-09')]),
      });
      const baylor = makeNurse({ scheduleKind: 'va_baylor' });
      const nightTour = scenario({
        nurses: [baylor],
        assignments: [assign(baylor.id, NIGHT_12, '2026-01-09')],
      });
      const [tour] = costSchedule(nightTour.schedule, friday).assignments;
      expect(tour?.lines.map((l) => l.kind)).toEqual(['base']);
      expect(tour?.total).toBe(600); // 12h × $50

      const dayShift = scenario({
        nurses: [baylor],
        assignments: [assign(baylor.id, DAY_12, '2026-01-09')],
      });
      // Friday 07:00–19:00 is no tour, so it earns what the unit pays. Weekend: $50 × 0.25 × 12 =
      // $150. Holiday on the running $62.50: $62.50 × 12 = $750. Night: only 18:00–19:00 is in
      // the window, 1h × $50 × 0.1 = $5 on base. 600 + 5 + 150 + 750 = 1505.
      const [day] = costSchedule(dayShift.schedule, friday).assignments;
      expect(day?.lines.map((l) => [l.kind, l.hours])).toEqual([
        ['base', 12],
        ['night', 1],
        ['weekend', 12],
        ['holiday', 12],
      ]);
      const amounts = lineAmounts(day!);
      expect(amounts.night).toBeCloseTo(5);
      expect(amounts.weekend).toBeCloseTo(150);
      expect(amounts.holiday).toBeCloseTo(750);
      expect(day?.total).toBeCloseTo(1505);
    });

    it('pays a Baylor nurse’s Wednesday night on a holiday every premium a standard nurse gets', () => {
      const baylor = makeNurse({ scheduleKind: 'va_baylor' });
      const s = scenario({
        nurses: [baylor],
        assignments: [assign(baylor.id, NIGHT_12, '2026-01-07')],
      });
      const [cost] = costSchedule(
        s.schedule,
        ctx({
          payRates: [payRate(50)],
          differentials: [night, weekend, holiday],
          holidayDates: new Set([isoDate('2026-01-07')]),
        }),
      ).assignments;
      // A Wednesday is no weekend tour. Night: $50 × 0.1 × 12 = $60. No weekend premium on a
      // Wednesday. Holiday on the running $55: $55 × 12 = $660. 600 + 60 + 660 = 1320.
      expect(cost?.lines.map((l) => l.kind)).toEqual(['base', 'night', 'holiday']);
      expect(cost?.total).toBeCloseTo(1320);
    });

    describe('a held-over hour under a night differential earned by the clock', () => {
      // Night 10% for 18:00–06:00, never the whole shift, so only in-window hours earn it.
      const partialNight = {
        ...night,
        window: { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: null },
      };
      function heldOverTour(shiftType: typeof DAY_12) {
        const baylor = makeNurse({ scheduleKind: 'va_baylor' });
        const s = scenario({
          nurses: [baylor],
          assignments: [assign(baylor.id, shiftType, '2026-01-10', { holdoverMinutes: 60 })],
        });
        return costSchedule(
          s.schedule,
          ctx({ payRates: [payRate(50)], differentials: [partialNight] }),
        ).assignments[0]!;
      }

      it('pays no night premium on an hour held past a night tour into the morning', () => {
        // Saturday 19:00–07:00 tour, held 07:00–08:00: the tour's 11 in-window hours are the
        // tour's, and the held hour is outside the window. 13h × $50 = $650 and nothing else.
        const cost = heldOverTour(NIGHT_12);
        expect(cost.lines.map((l) => l.kind)).toEqual(['base']);
        expect(cost.total).toBe(650);
      });

      it('pays the night premium on an hour held past a day tour into the evening', () => {
        // Saturday 07:00–19:00 tour, held 19:00–20:00: 18:00–19:00 is the tour's, so only the held
        // hour earns it, 1h × $50 × 0.1 = $5. 13h × $50 + $5 = $655.
        const cost = heldOverTour(DAY_12);
        expect(cost.lines.map((l) => [l.kind, l.hours])).toEqual([
          ['base', 13],
          ['night', 1],
        ]);
        expect(cost.total).toBeCloseTo(655);
      });
    });
  });

  describe('a 72/80 nurse’s day holding a 12 and an 8', () => {
    // Monday: an 8 at 07:00–15:00, then a 12 at 19:00–07:00. 20 hours on one workday.
    function priced(rule: OvertimeRule) {
      const nurse = makeNurse({ scheduleKind: 'va_72_80' });
      const s = scenario({
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_8, '2026-01-05'),
          assign(nurse.id, NIGHT_12, '2026-01-05'),
        ],
      });
      return costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [rule] })).assignments.map(
        (a) => a.overtimeHours,
      );
    }

    it('judges both shifts as a tour day, the 8 counting toward the twelve', () => {
      // 8 straight on the 8, then the 12 reaches 20: 8 hours past 12, all on the night.
      expect(priced(overtimeRule('daily', 12, 1.5, { tourDays: 'only' }))).toEqual([0, 8]);
    });

    it('judges neither shift by the non-tour rule', () => {
      // The day holds a tour, so past-8-on-a-non-tour-day prices nothing here.
      expect(priced(overtimeRule('daily', 8, 1.5, { tourDays: 'except' }))).toEqual([0, 0]);
    });
  });
});
