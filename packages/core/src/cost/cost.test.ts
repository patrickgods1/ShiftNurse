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
