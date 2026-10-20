/**
 * Every expected dollar figure here is worked by hand from the pay model in `types.ts`, never
 * re-derived with the code's own arithmetic. The fixture rates are deliberately "round":
 * RN $48, night +$4.50, weekend +$3, charge +$2.50, holiday ×1.5, on-call $6 standby, weekly
 * overtime past 40h at ×1.5. 2026-01-04 is a Sunday.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Assignment, Differential, OvertimeRule, PayRate, Unit } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import {
  assign,
  DAY_8,
  DAY_12,
  differential,
  EVENING_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  ON_CALL,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  scenario,
  testUnit,
  UNIT_ID,
} from '../testing/fixtures.js';
import {
  compareToBudget,
  costSchedule,
  hoursInDailyWindow,
  marginalCost,
  regularRateFrom,
} from './cost.js';
import type { CostContext, CostLine } from './types.js';

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
    // Only this period's shift is priced; the tail is context, not a cost. The week's regular rate
    // includes the tail: Saturday's twelve earns the $3 weekend differential, so 3 × 576 + 612 =
    // $2340 over 48h = $48.75 (29 CFR 778.115). Monday: 576 + 8 × 0.5 × 48.75 = 576 + 195 = 771.
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]?.overtimeHours).toBe(8);
    expect(report.totals.total).toBe(771);
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

  it('credits daily overtime toward the weekly forty by default: four twelves are sixteen overtime hours, not twenty', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40, DAILY_8] }));
    // A daily rule applies, so the weekly 40 counts straight hours only (29 CFR 778.202(c)):
    // 8 a shift, 32 for the week, under 40, so weekly adds nothing. Daily gives 4 a shift:
    // 16h × $24 (half of $48) = $384.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 4]);
    expect(report.totals.overtimePremium).toBe(384);
  });

  it('stacks daily overtime into the weekly forty only when the rule says so', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [{ ...WEEKLY_40, pyramiding: 'stack' }, DAILY_8] }),
    );
    // Every one of the 48 hours counts toward 40: the fourth shift crosses at 36 + 4, so its
    // last 8 hours are weekly overtime. 3 × 4 + 8 = 20h × $24 = $480.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([4, 4, 4, 8]);
    expect(report.totals.overtimePremium).toBe(480);
  });

  it('keeps stacking a weekly rule that has no daily rule beside it', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });

    const report = costSchedule(s.schedule, ctx({ overtimeRules: [WEEKLY_40] }));
    // 12, 24, 36, 48: the fourth twelve's last 8 hours are past 40.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 8]);
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

  it('finds no overtime in a week of exactly forty hours made of odd holdovers', () => {
    const nurse = makeNurse();
    const D695 = { ...DAY_8, id: 'st-d695', abbreviation: 'D695', durationHours: 6.95 };
    // Minutes: 720 + 1, 720 + 4, 480 + 58, then 6.95 × 60 = 417: 721 + 724 + 538 + 417 = 2400,
    // exactly 40 hours, so the weekly 40 is reached and never passed.
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, DAY_8, D695],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 1 }),
        assign(nurse.id, DAY_12, '2026-01-06', { holdoverMinutes: 4 }),
        assign(nurse.id, DAY_8, '2026-01-07', { holdoverMinutes: 58 }),
        assign(nurse.id, D695, '2026-01-08'),
      ],
    });

    const report = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(50)], differentials: [], overtimeRules: [WEEKLY_40] }),
    );
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0]);
    expect(report.totals.overtimeHours).toBe(0);
    expect(report.assignments.flatMap((a) => a.lines).filter((l) => l.kind === 'overtime')).toEqual(
      [],
    );
  });

  it('keeps the unit total equal to the sum of the shift totals to the cent', () => {
    const nurses = [1, 2, 3].map(() => makeNurse({ employmentType: 'agency' }));
    const s = scenario({
      nurses,
      assignments: nurses.map((n) => assign(n.id, NIGHT_12, '2026-01-05')),
    });

    const report = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(48.33)], differentials: [NIGHT, AGENCY] }),
    );
    // Straight rate (48.33 + 4.50) × 1.25 = 66.0375. Base 12 × 48.33 = 579.96; night
    // 12 × 4.50 = 54.00; agency increment 52.83 × 0.25 = 13.2075 an hour, 12 × 13.2075 = 158.49.
    // Shift 579.96 + 54 + 158.49 = 792.45; unit 3 × 792.45 = 2377.35.
    for (const cost of report.assignments) {
      expect(lineAmounts(cost)).toEqual({ base: 579.96, night: 54, agency: 158.49 });
      expect(cost.total).toBe(792.45);
    }
    expect(report.totals.total).toBe(2377.35);
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
    // The premium is on the week's regular rate. Sunday's and Saturday's shifts earn the $3
    // weekend differential: 8 × 51 + 5 × 8 × 48 + 12 × 51 = 408 + 1920 + 612 = $2940 over 60h =
    // $49. Saturday: 8 × 0.5 × 49 = 196 at time and a half, then 4 × 1 × 49 = 196 at double time.
    expect(report.totals.overtimePremium).toBe(392);
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
    // Mon–Wed twelves, Thu a thirteen: a weekly 40 that stacks makes the Thursday's last 9 hours
    // overtime at 1.5×; the daily rules make hours 8–12 1.5× and hour 13 2×. Per hour, the
    // highest wins: hours 4–12 at 1.5× (8 hours) and hour 13 at 2×.
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, DAY_13],
      assignments: [
        ...['2026-01-05', '2026-01-06', '2026-01-07'].map((d) => assign(nurse.id, DAY_12, d)),
        assign(nurse.id, DAY_13, '2026-01-08'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [{ ...WEEKLY_40, pyramiding: 'stack' }, ...CA_DAILY] }),
    );
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

  it('adds the candidate’s own price to the nurse’s total, to the cent', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06'].map((d) => assign(nurse.id, DAY_12, d)),
    });

    // $40.01 an hour, no differentials, no overtime: each twelve is 12 × 40.01 = $480.12. Before,
    // 2 × 480.12 = 960.24; after, 1,440.36; the difference is $480.12, where float subtraction
    // gives 480.1199999999999.
    const result = marginalCost(
      s.schedule,
      ctx({ payRates: [payRate(40.01)], differentials: [] }),
      candidate(nurse.id, '2026-01-07'),
    );
    expect(result.cost.total).toBe(480.12);
    expect(result.delta).toBe(480.12);
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

  it('reports twenty cents over, not a float shy of it', () => {
    // $1,000.30 against $1,000.10 is 20 cents over; float subtraction gives 0.1999999999999318.
    expect(compareToBudget(1000.3, 1000.1).variance).toBe(0.2);
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
    overrides: Partial<CostContext> = {},
  ) {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [shiftType],
      assignments: [assign(nurse.id, shiftType, '2026-01-05')],
    });
    const costs = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(50)], differentials, overtimeRules, ...overrides }),
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

  it('keeps the one evening hour of a day shift out of the overtime rate under additive stacking, and in it under compound', () => {
    // 07:00-19:00 with daily overtime past 8h; its 18:00-19:00 hour earns 10% night, $5.
    const ot = (c: ReturnType<typeof priced>) => c.lines.find((l) => l.kind === 'overtime')!;
    // Additive (38 U.S.C. § 7453): 4 overtime hours at half of the $50 base.
    const additive = priced(DAY_12, [night10], [DAILY_8], { premiumStacking: 'additive' });
    expect(ot(additive).rate).toBe(25);
    expect(additive.total).toBe(705); // 600 base + 5 night + 4 × 25 overtime
    // Compound (29 CFR 778.207(b)): the $5 is straight pay, so the regular rate is
    // 605 / 12 = 50.41666…; 4 × 0.5 × 50.41666… = 100.8333… → $100.83; 600 + 5 + 100.83.
    const compound = priced(DAY_12, [night10], [DAILY_8]);
    expect(ot(compound).amount).toBe(100.83);
    expect(compound.total).toBe(705.83);
    expect(ot(priced(DAY_12, [], [DAILY_8])).rate).toBe(25);
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

  it('counts a twelve held seven minutes past eight consecutive hours as four hours seven minutes', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 7 })],
    });
    const report = costSchedule(s.schedule, ctx({ ...rn50, overtimeRules: [consecutive(8)] }));
    // 720 + 7 = 727 minutes on the clock; past 480 that is 247 minutes. Premium 247/60 × $25 =
    // $102.9166… → $102.92.
    expect(report.assignments[0]?.overtimeHours).toBe(247 / 60);
    expect(report.assignments[0]?.lines.find((l) => l.kind === 'overtime')?.amount).toBe(102.92);
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

    const stacked = costSchedule(
      s.schedule,
      ctx({ overtimeRules: [{ ...WEEKLY_40, pyramiding: 'stack' }, DAILY_8] }),
    );
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

  it('credits a UC eight-hour nurse’s daily overtime toward the eighty, so one long day is not paid twice', () => {
    const nurse = makeNurse();
    // Pay period Sun 4 – Sat 17 Jan: a nine on Sun 4, then nine eights (81 hours in all).
    const eights = [
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
        assign(nurse.id, DAY_9, '2026-01-04'),
        ...eights.map((d) => assign(nurse.id, DAY_8, d)),
      ],
    });
    const priced = (payPeriod: OvertimeRule) =>
      costSchedule(s.schedule, ctx({ overtimeRules: [payPeriod, DAILY_8] }));

    // Absent pyramiding beside a daily rule credits: straight hours are 8 × 10 = 80, not past
    // 80, so the only overtime is the nine's ninth hour, daily.
    const credited = priced(overtimeRule('pay_period', 80));
    expect(credited.assignments.map((a) => a.overtimeHours)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(credited.nurses[0]?.overtimeHours).toBe(1);

    // Stacked, all 81 hours count: the last eight (Thu 15) crosses 80 by 1.
    const stacked = priced(overtimeRule('pay_period', 80, 1.5, { pyramiding: 'stack' }));
    expect(stacked.assignments.map((a) => a.overtimeHours)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(stacked.nurses[0]?.overtimeHours).toBe(2);
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
    // Premium on the week's regular rate, tail included: Saturday earns the $3 weekend
    // differential, 3 × 576 + 612 = $2340 over 48h = $48.75; 4h at 2× is 4 × 1 × 48.75 = 195.
    expect(report.assignments[0]?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 4, rate: 48.75, amount: 195 },
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

describe('a VA nurse working a holiday, under 38 U.S.C. § 7453', () => {
  // § 7453(d): holiday service, overtime included, is paid basic pay plus an equal amount.
  // § 7453(g): no overtime pay "for overtime service performed on a holiday … in addition to" that.
  // $50 basic pay; 2026-01-05 is a Monday, 2026-01-10 a Saturday.
  const BEYOND_TOUR = overtimeRule('beyond_scheduled_tour', 0, 1.5);

  function heldOverDayTour(holiday: boolean, covers: boolean | undefined) {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 60 })],
    });
    return costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [differential('holiday', 'multiplier', 2)],
        overtimeRules: [BEYOND_TOUR],
        holidayDates: holiday ? new Set([isoDate('2026-01-05')]) : new Set(),
        premiumStacking: 'additive',
        ...(covers === undefined ? {} : { holidayPayCoversOvertime: covers }),
      }),
    ).assignments[0]!;
  }

  it('pays the hour held past a holiday tour at double time and no overtime on top', () => {
    // 13 hours × ($50 + $50 holiday) = $1,300; the held hour is still overtime for the alert.
    const cost = heldOverDayTour(true, true);
    expect(cost.total).toBe(1300);
    expect(cost.overtimeHours).toBe(1);
    expect(cost.lines.some((l) => l.kind === 'overtime')).toBe(false);
  });

  it('adds half the base on the held hour when the unit pays overtime on holidays too', () => {
    // $1,300 plus 1 hour × $50 × 0.5 = $1,325.
    const cost = heldOverDayTour(true, undefined);
    expect(cost.total).toBe(1325);
    expect(cost.lines.find((l) => l.kind === 'overtime')).toEqual({
      kind: 'overtime',
      hours: 1,
      rate: 25,
      amount: 25,
    });
  });

  it('pays no overtime on top of major-holiday pay for the hour held past the tour', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 60 })],
    });
    const cost = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [differential('major_holiday', 'multiplier', 2)],
        overtimeRules: [BEYOND_TOUR],
        holidayDates: new Set([isoDate('2026-01-05')]),
        majorHolidayDates: new Set([isoDate('2026-01-05')]),
        premiumStacking: 'additive',
        holidayPayCoversOvertime: true,
      }),
    ).assignments[0]!;
    // 13 hours × ($50 + $50 major-holiday premium) = $1,300, nothing more.
    expect(cost.total).toBe(1300);
    expect(cost.overtimeHours).toBe(1);
    expect(cost.lines.some((l) => l.kind === 'overtime')).toBe(false);
  });

  it('pays a Baylor nurse held past a holiday Sunday tour holiday pay on the held hour and no overtime on top', () => {
    // § 7456(d): the scheduled Baylor tour earns no § 7453 premium; the held hour is outside the
    // tour, so it earns holiday and weekend pay, and § 7453(g) bars overtime pay on top.
    // Saturday 12 + Sunday 12 held 1 hour = 25 weekend hours: 1 past the Baylor 24.
    const nurse = makeNurse({ scheduleKind: 'va_baylor' });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-10'),
        assign(nurse.id, DAY_12, '2026-01-11', { holdoverMinutes: 60 }),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [
          differential('weekend', 'multiplier', 1.25),
          differential('holiday', 'multiplier', 2),
        ],
        overtimeRules: [
          overtimeRule('weekend', 24, 1.5, { pyramiding: 'none', scheduleKinds: ['va_baylor'] }),
        ],
        holidayDates: new Set([isoDate('2026-01-11')]),
        premiumStacking: 'additive',
        holidayPayCoversOvertime: true,
      }),
    );
    const sunday = report.assignments[1]!;
    // 12 scheduled hours × $50 = $600, plus the held hour at $50 + $50 + $12.50 = $112.50.
    expect(sunday.total).toBe(712.5);
    expect(sunday.overtimeHours).toBe(1);
    expect(sunday.lines.some((l) => l.kind === 'overtime')).toBe(false);
  });

  /**
   * A Baylor weekend after a Friday-night pickup: Friday 19:00–07:00 (`isOvertime`, so no tour)
   * puts 7 hours into the weekend, Saturday's 12 makes 19, and Sunday — a holiday — is the tour
   * that passes 24. Only the Sunday is returned.
   */
  function baylorHolidaySunday(sundayHoldoverMinutes: number) {
    const nurse = makeNurse({ scheduleKind: 'va_baylor' });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-09', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-10'),
        assign(nurse.id, DAY_12, '2026-01-11', { holdoverMinutes: sundayHoldoverMinutes }),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [
          differential('weekend', 'multiplier', 1.25),
          differential('holiday', 'multiplier', 2),
        ],
        overtimeRules: [
          overtimeRule('weekend', 24, 1.5, { pyramiding: 'none', scheduleKinds: ['va_baylor'] }),
        ],
        holidayDates: new Set([isoDate('2026-01-11')]),
        weekendDefinition: {
          startWeekday: 6,
          startMinute: 0,
          durationMinutes: 2 * 24 * 60,
          mode: 'overlaps',
        },
        premiumStacking: 'additive',
        holidayPayCoversOvertime: true,
      }),
    );
    return report.assignments.find((a) => a.date === '2026-01-11')!;
  }

  it('pays a Baylor nurse overtime on a holiday Sunday tour that earned no holiday pay', () => {
    // § 7456(d): the tour earns no holiday or weekend pay, so § 7453(g) has nothing to withhold
    // overtime "in addition to". 19 weekend hours before Sunday, so its last 7 are past 24:
    // 12 × $50 = $600, plus 7 × $25 = $175, total $775.
    const sunday = baylorHolidaySunday(0);
    expect(sunday.overtimeHours).toBe(7);
    expect(sunday.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 7, rate: 25, amount: 175 },
    ]);
    expect(sunday.total).toBe(775);
  });

  it('withholds overtime pay only on the held hour a Baylor nurse is paid holiday pay for', () => {
    // 8 overtime hours: the tour's last 7 keep their $25 premium ($175); the held hour is paid
    // $50 + $50 holiday + $12.50 weekend and no overtime on top. $600 + $175 + $112.50 = $887.50.
    const sunday = baylorHolidaySunday(60);
    expect(sunday.overtimeHours).toBe(8);
    expect(sunday.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 7, rate: 25, amount: 175 },
    ]);
    expect(sunday.total).toBe(887.5);
  });

  it('still pays overtime on an ordinary day when holiday pay covers holiday overtime', () => {
    // 13 hours × $50 = $650, plus 1 hour × $25 = $675.
    const cost = heldOverDayTour(false, true);
    expect(cost.total).toBe(675);
    expect(cost.overtimeHours).toBe(1);
  });

  function saturdayHolidayNight(premiumStacking: CostContext['premiumStacking']) {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-10')],
    });
    return costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [
          {
            ...differential('night', 'multiplier', 1.1),
            window: { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 4 },
          },
          differential('weekend', 'multiplier', 1.25),
          differential('holiday', 'multiplier', 2),
        ],
        holidayDates: new Set([isoDate('2026-01-10')]),
        weekendDefinition: {
          startWeekday: 6,
          startMinute: 0,
          durationMinutes: 2 * 24 * 60,
          mode: 'overlaps',
        },
        premiumStacking,
      }),
    ).assignments[0]!;
  }

  it('pays a Saturday holiday night each premium as its own share of basic pay', () => {
    // § 7453(g): computed separately on basic pay. $50 + $5 night + $12.50 weekend + $50 holiday
    // = $117.50 an hour; 12 hours = $1,410.
    const cost = saturdayHolidayNight('additive');
    expect(cost.straightRate).toBeCloseTo(117.5, 9);
    expect(cost.total).toBeCloseTo(1410, 9);
  });

  it('compounds the same night to $137.50 an hour under the FLSA regular rate', () => {
    // $50 × 1.1 × 1.25 × 2 = $137.50; 12 hours = $1,650.
    const cost = saturdayHolidayNight('compound');
    expect(cost.straightRate).toBeCloseTo(137.5, 9);
    expect(cost.total).toBeCloseTo(1650, 9);
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
      // base rate, out of the shift's own straight rate. Under compound stacking those dollars
      // are straight pay in the week's regular rate (29 CFR 778.207(b)): 667.50 / 13h =
      // 51.3461…, the same either side of Sunday midnight since this is the only shift; the held
      // hour's premium is 0.5 × 51.3461… = 25.673… → $25.67. 650 + 5 + 12.5 + 25.67 = 693.17.
      expect(cost?.lines.map((l) => [l.kind, l.hours])).toEqual([
        ['base', 13],
        ['night', 1],
        ['weekend', 1],
        ['overtime', 1],
      ]);
      const amounts = lineAmounts(cost!);
      expect(amounts.base).toBe(650);
      expect(amounts.night).toBe(5);
      expect(amounts.weekend).toBe(12.5);
      expect(amounts.overtime).toBe(25.67);
      expect(cost?.total).toBe(693.17);
    });

    it('pays the held hour’s overtime on the bare base under additive stacking (Title 38)', () => {
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
          premiumStacking: 'additive',
          overtimeRules: [
            overtimeRule('beyond_scheduled_tour', 0, 1.5, { scheduleKinds: ['va_baylor'] }),
          ],
        }),
      ).assignments;
      // § 7453 makes night pay and overtime both percentages of basic pay: half of $50 = $25.
      // 650 + 5 + 12.5 + 25 = 692.5.
      expect(lineAmounts(cost!).overtime).toBe(25);
      expect(cost?.total).toBe(692.5);
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

    it('pays a Baylor nurse’s extra Sunday pickup the weekend premium her tours go without', () => {
      // § 7456(b)(3)(B) withholds § 7453 pay only from a *regularly scheduled* tour; a 12 picked
      // up as overtime is not one. Sunday 2026-01-11, 07:00–19:00, $50 base, weekend 25%.
      const sunday = ctx({ payRates: [payRate(50)], differentials: [weekend] });
      const baylor = makeNurse({ scheduleKind: 'va_baylor' });
      const pickup = scenario({
        nurses: [baylor],
        assignments: [assign(baylor.id, DAY_12, '2026-01-11', { isOvertime: true })],
      });
      const [extra] = costSchedule(pickup.schedule, sunday).assignments;
      // 12h × $50 = $600, weekend 12h × $12.50 = $150.
      expect(extra?.lines.map((l) => [l.kind, l.hours])).toEqual([
        ['base', 12],
        ['weekend', 12],
      ]);
      expect(extra?.total).toBeCloseTo(750);

      const tour = scenario({
        nurses: [baylor],
        assignments: [assign(baylor.id, DAY_12, '2026-01-11')],
      });
      const [scheduled] = costSchedule(tour.schedule, sunday).assignments;
      expect(scheduled?.lines.map((l) => l.kind)).toEqual(['base']);
      expect(scheduled?.total).toBe(600);
    });

    describe('overtime past 24 hours in the weekend', () => {
      // § 7456(b)(3)(A): past 24 hours between midnight Friday and midnight Sunday, the unit's
      // weekend here (Saturday 00:00 for 48 hours). Saturday 2026-01-10's day and night tours are
      // 24 hours inside it; Sunday 2026-01-11's day 12 is the pickup.
      const WEEKEND_24 = overtimeRule('weekend', 24, 1.5, { scheduleKinds: ['va_baylor'] });
      const twoTours = (nurseId: string) => [
        assign(nurseId, DAY_12, '2026-01-10'),
        assign(nurseId, NIGHT_12, '2026-01-10'),
      ];
      const overtimeOf = (nurse: ReturnType<typeof makeNurse>, assignments: Assignment[]) =>
        costSchedule(
          scenario({ nurses: [nurse], assignments }).schedule,
          ctx({ ...rn50, overtimeRules: [WEEKEND_24] }),
        ).assignments.map((a) => a.overtimeHours);

      it('pays the whole Sunday pickup as overtime once the two tours reach 24 hours', () => {
        const baylor = makeNurse({ scheduleKind: 'va_baylor' });
        const pickup = assign(baylor.id, DAY_12, '2026-01-11', { isOvertime: true });
        // 12 + 12 = 24 on the tours; the pickup's 12 are all past 24.
        expect(overtimeOf(baylor, [...twoTours(baylor.id), pickup])).toEqual([0, 0, 12]);
      });

      it('pays no overtime on two weekend tours alone', () => {
        const baylor = makeNurse({ scheduleKind: 'va_baylor' });
        expect(overtimeOf(baylor, twoTours(baylor.id))).toEqual([0, 0]);
      });

      it('never judges a standard nurse by the Baylor weekend rule', () => {
        const standard = makeNurse();
        const pickup = assign(standard.id, DAY_12, '2026-01-11', { isOvertime: true });
        expect(overtimeOf(standard, [...twoTours(standard.id), pickup])).toEqual([0, 0, 0]);
      });

      it('counts only the Saturday hours of a Friday night toward the weekend', () => {
        // Friday 2026-01-09 19:00 – Saturday 07:00: 7 of its 12 hours are in the weekend. With
        // Saturday's and Sunday's day 12s that is 7 + 12 + 12 = 31, so Sunday's last 7 are over.
        const baylor = makeNurse({ scheduleKind: 'va_baylor' });
        expect(
          overtimeOf(baylor, [
            assign(baylor.id, NIGHT_12, '2026-01-09'),
            assign(baylor.id, DAY_12, '2026-01-10'),
            assign(baylor.id, DAY_12, '2026-01-11', { isOvertime: true }),
          ]),
        ).toEqual([0, 0, 7]);
      });

      it('counts only the Sunday hours of a Sunday night toward the weekend', () => {
        // Saturday and Sunday day 12s are 24; Sunday 19:00 – Monday 07:00 has 5 hours before
        // midnight, and those 5 are over.
        const baylor = makeNurse({ scheduleKind: 'va_baylor' });
        expect(
          overtimeOf(baylor, [
            assign(baylor.id, DAY_12, '2026-01-10'),
            assign(baylor.id, DAY_12, '2026-01-11'),
            assign(baylor.id, NIGHT_12, '2026-01-11', { isOvertime: true }),
          ]),
        ).toEqual([0, 0, 5]);
      });
    });

    describe('a Baylor nurse’s tour days', () => {
      // A Baylor tour day is a date with a regularly scheduled weekend tour; a weekday 12 is not
      // one, so it is judged past 8 (§ 7456(b)(3)(A)).
      const DAILY_8_OFF_TOUR = overtimeRule('daily', 8, 1.5, {
        tourDays: 'except',
        scheduleKinds: ['va_baylor'],
      });
      const overtimeOf = (date: string, overrides: Partial<Assignment> = {}) => {
        const baylor = makeNurse({ scheduleKind: 'va_baylor' });
        return costSchedule(
          scenario({ nurses: [baylor], assignments: [assign(baylor.id, DAY_12, date, overrides)] })
            .schedule,
          ctx({ ...rn50, overtimeRules: [DAILY_8_OFF_TOUR] }),
        ).assignments.map((a) => a.overtimeHours);
      };

      it('pays a Wednesday 12 picked up by a Baylor nurse the four hours past 8', () => {
        expect(overtimeOf('2026-01-07', { isOvertime: true })).toEqual([4]);
      });

      it('never judges a Baylor nurse’s Saturday tour by the 8', () => {
        expect(overtimeOf('2026-01-10')).toEqual([0]);
      });

      // § 7456(b)(3)(A) judges a Saturday, a Sunday and a Friday night running into Saturday by
      // the weekend's 24 alone, whoever was scheduled: a pickup there is never judged past 8.
      const WEEKEND_24 = overtimeRule('weekend', 24, 1.5, {
        pyramiding: 'none',
        scheduleKinds: ['va_baylor'],
      });
      const priced = (assignments: (id: string) => Assignment[], rules: OvertimeRule[]) => {
        const baylor = makeNurse({ scheduleKind: 'va_baylor' });
        return costSchedule(
          scenario({ nurses: [baylor], assignments: assignments(baylor.id) }).schedule,
          ctx({ ...rn50, overtimeRules: rules }),
        ).assignments.map((a) => a.overtimeHours);
      };

      it('judges a Friday night pickup by the weekend’s 24, never by the 8', () => {
        // Friday 2026-01-09 19:00 – Saturday 07:00 picked up, then the Saturday and Sunday day
        // tours. Its 5 Friday hours are not judged past 8 (the date is a weekend tour day). The
        // weekend holds 7 of its hours + 12 + 12 = 31, 7 past 24; hours accrue in the order they
        // are worked, so the 7 are the last ones, Sunday's.
        const fridayPickup = (id: string) => [
          assign(id, NIGHT_12, '2026-01-09', { isOvertime: true }),
          assign(id, DAY_12, '2026-01-10'),
          assign(id, DAY_12, '2026-01-11'),
        ];
        expect(priced(fridayPickup, [DAILY_8_OFF_TOUR])).toEqual([0, 0, 0]);
        expect(priced(fridayPickup, [WEEKEND_24, DAILY_8_OFF_TOUR])).toEqual([0, 0, 7]);
      });

      it('judges a Saturday day pickup by the weekend’s 24, never by the 8', () => {
        // Saturday 07:00–19:00 picked up, the only shift dated Saturday, between the Friday night
        // and Sunday day tours. Past 8 on a Saturday is never judged. The weekend holds the
        // Friday night's 7 + 12 + 12 = 31, 7 past 24, the last 7 worked: Sunday's.
        const saturdayPickup = (id: string) => [
          assign(id, NIGHT_12, '2026-01-09'),
          assign(id, DAY_12, '2026-01-10', { isOvertime: true }),
          assign(id, DAY_12, '2026-01-11'),
        ];
        expect(priced(saturdayPickup, [DAILY_8_OFF_TOUR])).toEqual([0, 0, 0]);
        expect(priced(saturdayPickup, [WEEKEND_24, DAILY_8_OFF_TOUR])).toEqual([0, 0, 7]);
      });
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

describe('UC–CNA consecutive-shift premium', () => {
  // Art. 14 § I.3: more than four full 12s within four days is paid 1.5× until a day off. $50 base,
  // no other differential, so the premium is $25 an hour on the shifts that earn it.
  const consecutiveShift: Differential = {
    ...differential('consecutive_shift', 'multiplier', 1.5),
    consecutive: { afterShifts: 4, withinDays: 4 },
  };
  const ucCtx = () => ctx({ payRates: [payRate(50)], differentials: [consecutiveShift] });
  const premiumLines = (cost: { lines: CostLine[] } | undefined) =>
    (cost?.lines ?? []).filter((l) => l.kind === 'consecutive_shift');

  it('pays the fifth 12 in five days at time and a half, and not the first four', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });
    const costs = costSchedule(s.schedule, ucCtx()).assignments;
    expect(costs.map((c) => premiumLines(c).length)).toEqual([0, 0, 0, 0, 1]);
    expect(premiumLines(costs[4])).toEqual([
      { kind: 'consecutive_shift', hours: 12, rate: 25, amount: 300 },
    ]);
    expect(costs[4]?.total).toBe(900); // 12h × $75
  });

  it('pays nothing extra when a day off breaks the run after four', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-10'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });
    const costs = costSchedule(s.schedule, ucCtx()).assignments;
    expect(costs.flatMap((c) => premiumLines(c))).toEqual([]);
  });

  it('counts the last schedule’s three 12s toward this one’s fifth', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      priorAssignments: ['2026-01-01', '2026-01-02', '2026-01-03'].map((d) =>
        assign(nurse.id, DAY_12, d, { periodId: 'period-0' }),
      ),
      assignments: [assign(nurse.id, DAY_12, '2026-01-04'), assign(nurse.id, DAY_12, '2026-01-05')],
    });
    const costs = costSchedule(s.schedule, ucCtx()).assignments;
    expect(costs).toHaveLength(2);
    expect(costs.map((c) => premiumLines(c).length)).toEqual([0, 1]);
    expect(premiumLines(costs[1])[0]?.amount).toBe(300);
  });

  it('pays a Baylor nurse’s Sunday tour the premium after four days in a row, weekend pay still withheld', () => {
    // Wednesday to Sunday, five day 12s. The weekday three are off the Baylor plan (the tour-plan
    // rule would flag them), but pricing does not care. Sunday is a Baylor tour: § 7456(d) withholds
    // its $3 weekend differential, yet the contract's consecutive-shift premium is not § 7453 pay,
    // so it is still paid: $50 + $25 for 12 hours.
    const baylor = makeNurse({ scheduleKind: 'va_baylor' });
    const s = scenario({
      nurses: [baylor],
      assignments: ['2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'].map((d) =>
        assign(baylor.id, DAY_12, d),
      ),
    });
    const costs = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [consecutiveShift, diff('weekend', 'flat', 3)],
      }),
    ).assignments;
    const sunday = costs[4];
    expect(sunday?.date).toBe('2026-01-11');
    expect(sunday?.lines).toEqual([
      { kind: 'base', hours: 12, rate: 50, amount: 600 },
      { kind: 'consecutive_shift', hours: 12, rate: 25, amount: 300 },
    ]);
    expect(sunday?.total).toBe(900);
    expect(costs.slice(0, 4).flatMap((c) => premiumLines(c))).toEqual([]);
  });

  it('lets an 8 keep the run going without counting toward the twelves', () => {
    // {4, 6}: 12, 12, 8, 12, 12, 12 on six days. The fifth day holds only four 12s (the 8 does not
    // count); the sixth holds five, which it could not if the 8 had broken the run.
    const nurse = makeNurse();
    const premium = { ...consecutiveShift, consecutive: { afterShifts: 4, withinDays: 6 } };
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
        assign(nurse.id, DAY_8, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-08'),
        assign(nurse.id, DAY_12, '2026-01-09'),
        assign(nurse.id, DAY_12, '2026-01-10'),
      ],
    });
    const costs = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(50)], differentials: [premium] }),
    ).assignments;
    expect(costs.map((c) => premiumLines(c).length)).toEqual([0, 0, 0, 0, 0, 1]);
  });

  it('keeps paying the premium until a day off even when the count falls back', () => {
    // {2, 2}: three 12s cross on the third day; the two 8s after it leave two and then one 12 in
    // their windows, under the threshold, but there has been no day off, so both still earn it.
    const nurse = makeNurse();
    const premium = { ...consecutiveShift, consecutive: { afterShifts: 2, withinDays: 2 } };
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_8, '2026-01-08'),
        assign(nurse.id, DAY_8, '2026-01-09'),
      ],
    });
    const costs = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(50)], differentials: [premium] }),
    ).assignments;
    expect(costs.map((c) => premiumLines(c).length)).toEqual([0, 0, 1, 1, 1]);
    // The 8s earn it on their own 8 hours: 8 × $25.
    expect(premiumLines(costs[4])[0]?.amount).toBe(200);
  });

  it('pays the third and fourth of four 12s under more than two in two days', () => {
    // {2, 2}: the third day sees days one to three, three 12s; the fourth sees two to four.
    const nurse = makeNurse();
    const premium = { ...consecutiveShift, consecutive: { afterShifts: 2, withinDays: 2 } };
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });
    const costs = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(50)], differentials: [premium] }),
    ).assignments;
    expect(costs.map((c) => premiumLines(c).length)).toEqual([0, 0, 1, 1]);
  });

  it('pays nothing for a consecutive-shift premium with no shifts and days set', () => {
    const nurse = makeNurse();
    const { consecutive: _unset, ...bare } = consecutiveShift;
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map((d) =>
        assign(nurse.id, DAY_12, d),
      ),
    });
    const costs = costSchedule(
      s.schedule,
      ctx({ payRates: [payRate(50)], differentials: [bare] }),
    ).assignments;
    expect(costs.flatMap((c) => premiumLines(c))).toEqual([]);
    expect(costs.map((c) => c.total)).toEqual([600, 600, 600, 600, 600]);
  });

  it('pays the premium on every hour of a fifth 12 held over an hour', () => {
    // The fifth shift is paid 13 hours, all of them past the threshold: 13 × $25 = $325.
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
          assign(nurse.id, DAY_12, d),
        ),
        assign(nurse.id, DAY_12, '2026-01-09', { holdoverMinutes: 60 }),
      ],
    });
    const costs = costSchedule(s.schedule, ucCtx()).assignments;
    expect(premiumLines(costs[4])).toEqual([
      { kind: 'consecutive_shift', hours: 13, rate: 25, amount: 325 },
    ]);
  });
});

describe('overtime past hours in the weekend window', () => {
  // $50 base, no differentials; 2026-01-09 is a Friday, 01-10 a Saturday, 01-11 a Sunday. The
  // default weekend runs Saturday 00:00 to Monday 00:00.
  const plain = { payRates: [payRate(50)], differentials: [] };
  const FRIDAY_NOON_12 = { ...DAY_12, id: 'st-n-12', abbreviation: 'M12', startTime: '12:00' };
  const LATE_8 = { ...DAY_8, id: 'st-l8', abbreviation: 'L8', startTime: '23:00' };
  const shiftTypes = [DAY_12, NIGHT_12, DAY_8, FRIDAY_NOON_12, LATE_8];
  function overtimeOf(
    assignments: (nurseId: string) => Assignment[],
    rules: OvertimeRule[],
    overrides: Partial<CostContext> = {},
    prior?: (nurseId: string) => Assignment[],
  ) {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes,
      assignments: assignments(nurse.id),
      ...(prior ? { priorAssignments: prior(nurse.id) } : {}),
    });
    return costSchedule(s.schedule, ctx({ ...plain, overtimeRules: rules, ...overrides }))
      .assignments;
  }
  const WEEKEND_24 = overtimeRule('weekend', 24, 1.5);

  it('counts the one hour of a Friday day inside a weekend that opens Friday at 18:00', () => {
    // A weekend from Friday 18:00 for 54 hours, to Monday 00:00. Friday 07:00–19:00 has one hour
    // in it (18:00–19:00); with Saturday's and Sunday's day 12s that is 1 + 12 + 12 = 25, 1 past
    // 24, the last hour worked. Under the default weekend the Friday day has none: 24, no overtime.
    const shifts = (id: string) => [
      assign(id, DAY_12, '2026-01-09'),
      assign(id, DAY_12, '2026-01-10'),
      assign(id, DAY_12, '2026-01-11'),
    ];
    const fridayEvening = {
      weekendDefinition: {
        ...DEFAULT_WEEKEND,
        startWeekday: 5 as const,
        startMinute: 18 * 60,
        durationMinutes: 54 * 60,
      },
    };
    expect(overtimeOf(shifts, [WEEKEND_24], fridayEvening).map((a) => a.overtimeHours)).toEqual([
      0, 0, 1,
    ]);
    expect(overtimeOf(shifts, [WEEKEND_24]).map((a) => a.overtimeHours)).toEqual([0, 0, 0]);
  });

  it('gives the weekend nothing from a Friday shift ending at midnight', () => {
    // Friday 12:00–24:00 ends as the weekend opens: 0 hours. Saturday and Sunday day 12s are 24,
    // not past it. Had the Friday counted, the weekend would hold 36 and pay 12.
    const shifts = (id: string) => [
      assign(id, FRIDAY_NOON_12, '2026-01-09'),
      assign(id, DAY_12, '2026-01-10'),
      assign(id, DAY_12, '2026-01-11'),
    ];
    expect(overtimeOf(shifts, [WEEKEND_24]).map((a) => a.overtimeHours)).toEqual([0, 0, 0]);
  });

  it('gives the weekend one hour from a Sunday shift starting at 23:00', () => {
    // Sunday 23:00 – Monday 07:00: 23:00–24:00 is the weekend's. 12 + 12 + 1 = 25, 1 past 24.
    const shifts = (id: string) => [
      assign(id, DAY_12, '2026-01-10'),
      assign(id, DAY_12, '2026-01-11'),
      assign(id, LATE_8, '2026-01-11'),
    ];
    expect(overtimeOf(shifts, [WEEKEND_24]).map((a) => a.overtimeHours)).toEqual([0, 0, 1]);
  });

  it('does not count hours already paid past 12 in a day toward the weekend when told not to', () => {
    // Saturday 07:00–19:00 held over to 21:00 (14 hours), then Sunday's day 12. Daily 12 makes
    // Saturday's last 2 hours overtime. Stacking, the weekend counts all 14 + 12 = 26, 2 past 24,
    // on Sunday. Not pyramiding, Saturday adds only its 12 straight hours (07:00–19:00):
    // 12 + 12 = 24, not past it, so Sunday is straight time.
    const shifts = (id: string) => [
      assign(id, DAY_12, '2026-01-10', { holdoverMinutes: 120 }),
      assign(id, DAY_12, '2026-01-11'),
    ];
    const daily12 = overtimeRule('daily', 12, 1.5);
    const stack = overtimeOf(shifts, [
      daily12,
      overtimeRule('weekend', 24, 1.5, { pyramiding: 'stack' }),
    ]);
    expect(stack.map((a) => a.overtimeHours)).toEqual([2, 2]);
    const none = overtimeOf(shifts, [
      daily12,
      overtimeRule('weekend', 24, 1.5, { pyramiding: 'none' }),
    ]);
    expect(none.map((a) => a.overtimeHours)).toEqual([2, 0]);
  });

  it('counts seven minutes held over on Sunday as seven minutes past the weekend’s 24', () => {
    // Saturday's day 12 (720 minutes) and Sunday's held over 7 (727): 1,447 minutes, 7 past 1,440.
    // Premium 7/60 × $25 = $2.9166… → $2.92.
    const costs = overtimeOf(
      (id) => [
        assign(id, DAY_12, '2026-01-10'),
        assign(id, DAY_12, '2026-01-11', { holdoverMinutes: 7 }),
      ],
      [WEEKEND_24],
    );
    expect(costs.map((a) => a.overtimeHours)).toEqual([0, 7 / 60]);
    expect(costs[1]?.lines.find((l) => l.kind === 'overtime')?.amount).toBe(2.92);
  });

  it('does not pay ten minutes past the weekend’s 24 under a 15-minute minimum', () => {
    // Saturday's day 12 and Sunday's held over 10 minutes: 24h10m, 10 minutes past 24.
    const shifts = (id: string) => [
      assign(id, DAY_12, '2026-01-10'),
      assign(id, DAY_12, '2026-01-11', { holdoverMinutes: 10 }),
    ];
    const without = overtimeOf(shifts, [WEEKEND_24]);
    expect(without[1]?.overtimeHours).toBeCloseTo(10 / 60, 10);
    const withMinimum = overtimeOf(shifts, [
      overtimeRule('weekend', 24, 1.5, { minimumMinutes: 15 }),
    ]);
    expect(withMinimum.map((a) => a.overtimeHours)).toEqual([0, 0]);
  });

  it('counts last schedule’s Saturday toward the weekend but prices only this schedule’s Sunday', () => {
    // This period starts Sunday 2026-01-04. From the last one: Friday 01-02's night (7 hours
    // after Saturday 00:00) and Saturday 01-03's day and night 12s, 7 + 12 + 12 = 31, the
    // Saturday night crossing 24. That tail is context, never priced. Sunday's day 12 is all past
    // 24: 12 hours of overtime, the only overtime reported.
    const costs = overtimeOf(
      (id) => [assign(id, DAY_12, '2026-01-04')],
      [WEEKEND_24],
      {},
      (id) => [
        assign(id, NIGHT_12, '2026-01-02', { periodId: 'period-0' }),
        assign(id, DAY_12, '2026-01-03', { periodId: 'period-0' }),
        assign(id, NIGHT_12, '2026-01-03', { periodId: 'period-0' }),
      ],
    );
    expect(costs.map((a) => [a.date, a.overtimeHours])).toEqual([['2026-01-04', 12]]);
  });
});

describe('a shift that crosses into a new work week or pay period', () => {
  // $50 base, no differentials, weeks from Sunday: a 1.5× premium hour is $25. 2026-01-10 is a
  // Saturday; a 19:00–07:00 night that day works 5 hours before Sunday midnight and 7 after.
  const plain = { payRates: [payRate(50)], differentials: [] };
  const r2 = () => {
    const nurse = makeNurse();
    return scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-10'),
        ...['2026-01-12', '2026-01-13', '2026-01-14'].map((d) => assign(nurse.id, DAY_12, d)),
      ],
    });
  };
  const mirror = () => {
    const nurse = makeNurse();
    return scenario({
      nurses: [nurse],
      assignments: [
        ...['2026-01-07', '2026-01-08', '2026-01-09'].map((d) => assign(nurse.id, DAY_12, d)),
        assign(nurse.id, NIGHT_12, '2026-01-10'),
      ],
    });
  };

  it('counts the Sunday-morning hours of a Saturday night in the new week', () => {
    const report = costSchedule(r2().schedule, ctx({ ...plain, overtimeRules: [WEEKLY_40] }));
    // The night gives 5h to the week of 01-04 and 7h to the week of 01-11, which then holds
    // 7 + 36 = 43: 3h past 40, on the last twelve. 600 + 3 × 25 = 675.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 3]);
    expect(report.assignments.map((a) => a.total)).toEqual([600, 600, 600, 675]);
  });

  it('pays only the Saturday-evening hour past forty when the rest of the night falls in the next week', () => {
    const report = costSchedule(mirror().schedule, ctx({ ...plain, overtimeRules: [WEEKLY_40] }));
    // The week of 01-04 holds 36 + 5 = 41: 1h over, the night's 23:00–24:00 hour; its 7 Sunday
    // hours open the next week. 600 + 1 × 25 = 625.
    const night = report.assignments[3]!;
    expect(night.overtimeHours).toBe(1);
    expect(night.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 1, rate: 25, amount: 25 },
    ]);
    expect(night.total).toBe(625);

    // Counted by its start, the whole night is the first week's: 36 + 12 = 48, its last 8 hours
    // over. 600 + 8 × 25 = 800.
    const byStart = costSchedule(
      mirror().schedule,
      ctx({ ...plain, overtimeRules: [WEEKLY_40], overtimeWindowAttribution: 'start' }),
    );
    expect(byStart.assignments[3]?.overtimeHours).toBe(8);
    expect(byStart.assignments[3]?.total).toBe(800);
  });

  it('keeps the whole night in the week it starts when the unit counts shifts by their start', () => {
    const report = costSchedule(
      r2().schedule,
      ctx({ ...plain, overtimeRules: [WEEKLY_40], overtimeWindowAttribution: 'start' }),
    );
    // The night is all the week of 01-04's; the week of 01-11 holds 36.
    expect(report.assignments.map((a) => a.overtimeHours)).toEqual([0, 0, 0, 0]);
  });

  it('puts the Sunday-morning hours of a Saturday night in the next pay period under 8/80', () => {
    // Pay periods Jan 4–17 and Jan 18–31 (the fixture anchors them on Sunday 4 Jan).
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
        ...['2026-01-19', '2026-01-20', '2026-01-21', '2026-01-26', '2026-01-27', '2026-01-28'].map(
          (d) => assign(nurse.id, DAY_12, d),
        ),
      ],
    });
    const eighty = overtimeRule('pay_period', 80);
    // By the clock: the first pay period holds 72 + 5 = 77, the second 7 + 72 = 79. Neither
    // passes 80.
    const clock = costSchedule(s.schedule, ctx({ ...plain, overtimeRules: [eighty] }));
    expect(clock.totals.overtimeHours).toBe(0);
    // By the start: the first holds 72 + 12 = 84, 4h past 80 on the night.
    const start = costSchedule(
      s.schedule,
      ctx({ ...plain, overtimeRules: [eighty], overtimeWindowAttribution: 'start' }),
    );
    expect(start.totals.overtimeHours).toBe(4);
  });

  it('lets holiday pay cover only the overtime hours worked on the holiday when a night is split at the week boundary', () => {
    const report = costSchedule(
      mirror().schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [HOLIDAY],
        holidayDates: new Set([isoDate('2026-01-10')]),
        holidayPayCoversOvertime: true,
        overtimeRules: [WEEKLY_40],
      }),
    );
    // The night is dated on the holiday, so all 12h earn ×1.5; its one overtime hour (minutes
    // 240–300) is holiday pay already and gets no premium, though it still counts.
    // 12 × 50 × 1.5 = 900.
    const night = report.assignments[3]!;
    expect(night.overtimeHours).toBe(1);
    expect(night.lines.some((l) => l.kind === 'overtime')).toBe(false);
    expect(night.total).toBe(900);
  });
});

describe('the overtime premium on the week’s regular rate (29 CFR 778.115)', () => {
  const nightTenPercent = differential('night', 'multiplier', 1.1);
  const pricedWith = (differentials: Differential[], overrides: Partial<CostContext> = {}) =>
    ctx({ payRates: [payRate(50)], differentials, overtimeRules: [WEEKLY_40], ...overrides });

  it('charges the same premium whichever day the night shift falls on', () => {
    const week = (night: string) => {
      const nurse = makeNurse();
      return scenario({
        nurses: [nurse],
        assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
          assign(nurse.id, d === night ? NIGHT_12 : DAY_12, d),
        ),
      });
    };
    // RR = (36 × 50 + 12 × 55) / 48 = 2460 / 48 = 51.25; premium 8 × 0.5 × 51.25 = 205;
    // nurse total 2460 + 205 = 2665, night last or first.
    for (const night of ['2026-01-08', '2026-01-05']) {
      const report = costSchedule(week(night).schedule, pricedWith([nightTenPercent]));
      expect(report.totals.overtimePremium).toBe(205);
      expect(report.totals.total).toBe(2665);
    }
  });

  it('puts a clock-window night differential into the overtime rate', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, NIGHT_12, d),
      ),
    });
    const windowed: Differential = {
      ...differential('night', 'flat', 5),
      window: { startTime: '23:00', endTime: '07:00', wholeShiftAtHours: null },
    };
    // 8 in-window hours a night, $40, $160 a week. RR = (48 × 50 + 160) / 48 = 53.333…;
    // premium 8 × 0.5 × 53.333… = 213.333… → $213.33 (778.207(b)).
    expect(costSchedule(s.schedule, pricedWith([windowed])).totals.overtimePremium).toBe(213.33);
  });

  it('keeps the clock-window night differential out of the overtime rate under additive stacking', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, NIGHT_12, d),
      ),
    });
    const windowed: Differential = {
      ...differential('night', 'flat', 5),
      window: { startTime: '23:00', endTime: '07:00', wholeShiftAtHours: null },
    };
    // 8 × 0.5 × 50 = 200.
    const report = costSchedule(
      s.schedule,
      pricedWith([windowed], { premiumStacking: 'additive' }),
    );
    expect(report.totals.overtimePremium).toBe(200);
  });

  it('prices 8/80 overtime on the fortnight’s regular rate, not the week’s (29 CFR 778.601(e))', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map((d) =>
          assign(nurse.id, DAY_8, d),
        ),
        // Each N8 ends at 07:00 next morning; the 01-16 D8 starts then (half-open, no overlap).
        ...['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15'].map((d) =>
          assign(nurse.id, NIGHT_8, d),
        ),
        ...['2026-01-16', '2026-01-17'].map((d) => assign(nurse.id, DAY_8, d)),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [differential('night', 'flat', 5)],
        overtimeRules: [overtimeRule('pay_period', 80)],
      }),
    );
    // 7 × 8 = 56h at $50 = 2800 and 4 × 8 = 32h at $55 = 1760: 88h, $4560, RR 51.8181…. The
    // 01-17 D8 is the 8h past 80: 8 × 0.5 × 51.8181… = 207.2727… → $207.27. (The week of 01-11
    // alone would give (1760 + 800) / 48 = 53.333… → $213.33.)
    expect(report.assignments.map((a) => a.overtimeHours).at(-1)).toBe(8);
    expect(report.totals.overtimePremium).toBe(207.27);
  });

  it('uses last period’s straight time in the week’s regular rate without pricing it', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      priorAssignments: [
        assign(nurse.id, NIGHT_12, '2026-01-01', { periodId: 'period-0' }),
        assign(nurse.id, NIGHT_12, '2026-01-02', { periodId: 'period-0' }),
        assign(nurse.id, DAY_12, '2026-01-03', { periodId: 'period-0' }),
      ],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05')],
    });
    const report = costSchedule(s.schedule, pricedWith([nightTenPercent], { workWeekStartsOn: 4 }));
    // Thursday-to-Wednesday week: 48h, 2 × 660 + 2 × 600 = $2520, RR 52.5. Monday carries the
    // 8h past 40: 8 × 0.5 × 52.5 = 210; Monday 600 + 210 = 810.
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]?.total).toBe(810);
  });
});

describe('the pieces of a shift split at the window edge', () => {
  // $50 base, weeks from Sunday. Sat 01-10's 19:00 night works 300 minutes before Sunday midnight
  // and the rest after; Mon 01-12 is in the week of 01-11.
  const plain = { payRates: [payRate(50)], differentials: [] };
  const leaveIn = (nurseId: string, hours: number) =>
    new Map([[nurseId, [{ nurseId, date: isoDate('2026-01-12'), hours }]]]);

  it('pays a Baylor nurse’s Saturday-evening overtime hour although holiday pay covers her held hour', () => {
    const nurse = makeNurse({ scheduleKind: 'va_baylor' });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...['2026-01-07', '2026-01-08', '2026-01-09'].map((d) => assign(nurse.id, DAY_12, d)),
        assign(nurse.id, NIGHT_12, '2026-01-10', { holdoverMinutes: 60 }),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [HOLIDAY],
        holidayDates: new Set([isoDate('2026-01-10')]),
        holidayPayCoversOvertime: true,
        premiumStacking: 'additive',
        overtimeRules: [WEEKLY_40],
      }),
    );
    // Week of 01-04: 36 + 5 = 41h, so the night's minutes 240–300 are overtime. Holiday pay covers
    // only the held hour, minutes 720–780 (§ 7456(d), § 7453(g)), so that band keeps its premium:
    // 1 × 0.5 × 50 = 25. The held hour's holiday pay is 1 × 50 × 0.5 = 25. 13 × 50 + 25 + 25 = 700.
    const night = report.assignments[3]!;
    expect(night.overtimeHours).toBe(1);
    expect(night.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 1, rate: 25, amount: 25 },
    ]);
    expect(night.total).toBe(700);
  });

  it('pays a 30-minute minimum on the overtime of both weeks together', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-08'),
        assign(nurse.id, DAY_8, '2026-01-09', { holdoverMinutes: 190 }),
        assign(nurse.id, NIGHT_12, '2026-01-10'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        ...plain,
        overtimeRules: [{ ...WEEKLY_40, minimumMinutes: 30 }],
        overtimeLeave: leaveIn(nurse.id, 33.5),
      }),
    );
    // Week of 01-04: 720 + 720 + (480 + 190) = 2110 minutes, then the night's 300: 2410,
    // 10 past 2400, minutes 290–300. Week of 01-11: 33.5h of counted leave (2010), then the night's
    // 420: 2430, 30 past, minutes 690–720. Under the 30-minute minimum on its own the first piece
    // would go; together they are 40 minutes, so both are paid: 10/60 × 25 = 4.1666… → $4.17 and
    // 30/60 × 25 = $12.50.
    const night = report.assignments[3]!;
    expect(night.overtimeHours).toBe(40 / 60);
    expect(night.lines.filter((l) => l.kind === 'overtime').map((l) => l.amount)).toEqual([
      4.17, 12.5,
    ]);
  });

  it('runs a Saturday night’s Sunday overtime under its daily premium hours when the week does not pyramid', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-10')],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        ...plain,
        overtimeRules: [
          overtimeRule('weekly', 40, 2, { pyramiding: 'none' }),
          overtimeRule('daily', 8),
        ],
        overtimeLeave: leaveIn(nurse.id, 40),
      }),
    );
    // Straight minutes are the first 480 (daily 8). The week of 01-04 gets 300 of them, nowhere
    // near 40. The week of 01-11 already holds 40h of leave, so the night's other 180 straight
    // minutes are all over, and that overtime runs to the shift's end: minutes 300–720 at 2×,
    // above the daily 1.5× on 480–720. 7h × 1 × 50 = $350.
    const night = report.assignments[0]!;
    expect(night.overtimeHours).toBe(7);
    expect(night.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 7, rate: 50, amount: 350 },
    ]);
  });

  it('pays the Saturday-evening hour past eighty when a night runs into the next pay period', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-12', '2026-01-13'].map((d) =>
          assign(nurse.id, DAY_12, d),
        ),
        ...['2026-01-08', '2026-01-14'].map((d) => assign(nurse.id, DAY_8, d)),
        assign(nurse.id, NIGHT_12, '2026-01-17'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({ ...plain, overtimeRules: [overtimeRule('pay_period', 80)] }),
    );
    // Pay period Jan 4–17: 5 × 12 + 2 × 8 = 76h, then the night's 19:00–24:00: 81, 1h past 80
    // (its 23:00 hour). Its 7 Sunday hours open the next pay period. 1 × 0.5 × 50 = 25.
    const night = report.assignments.at(-1)!;
    expect(night.overtimeHours).toBe(1);
    expect(night.total).toBe(625);
  });
});

describe('holiday premium by the unit’s attribution', () => {
  // $50, Christmas ×1.5 only. The 12-24 night works 5h on Christmas Eve and 7h on Christmas; the
  // 12-25 night 5h on Christmas and 7h on the 26th.
  const twoNights = () => {
    const nurse = makeNurse();
    return scenario({
      startDate: isoDate('2026-12-20'),
      endDate: isoDate('2027-01-02'),
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-12-24'),
        assign(nurse.id, NIGHT_12, '2026-12-25'),
      ],
    });
  };
  const christmas = (
    holidayAttribution: Unit['holidayAttribution'],
    overrides: Partial<CostContext> = {},
  ) =>
    ctx({
      unit: { ...testUnit, ...(holidayAttribution ? { holidayAttribution } : {}) },
      payRates: [payRate(50)],
      differentials: [HOLIDAY],
      holidayDates: new Set([isoDate('2026-12-25')]),
      ...overrides,
    });
  const totals = (c: CostContext) =>
    costSchedule(twoNights().schedule, c).assignments.map((a) => a.total);

  it('pays the Christmas night, not the Christmas Eve night, by start date', () => {
    // 12 × 50 = 600; 12 × 50 × 1.5 = 900.
    expect(totals(christmas('start'))).toEqual([600, 900]);
    expect(totals(christmas(undefined))).toEqual([600, 900]);
  });

  it('pays the holiday premium on the hours worked on Christmas by the clock', () => {
    // Eve night: 600 + 7 × 50 × 0.5 = 775; Christmas night: 600 + 5 × 25 = 725.
    expect(totals(christmas('clock'))).toEqual([775, 725]);
  });

  it('pays the whole night that is mostly on Christmas by majority', () => {
    // The Eve night is 7 of 12 hours on Christmas: 900. The Christmas night is 5 of 12: 600.
    expect(totals(christmas('majority'))).toEqual([900, 600]);
  });

  it('pays a Baylor nurse holiday premium by the clock only on the held hour that falls on the holiday', () => {
    // Saturday 2026-12-26 declared a holiday. A Friday night into Saturday is a Baylor tour, whose
    // scheduled hours earn no holiday pay (§ 7456(d)) whatever the attribution; held to 08:00, its
    // held hour 07:00–08:00 is on the holiday and earns it on base: 1 × 50 × 0.5 = 25.
    // 13 × 50 + 25 = 675. A standard nurse earns it on all 8 hours on the 26th: 650 + 8 × 25 = 850.
    const cost = (scheduleKind: 'va_baylor' | 'standard') => {
      const nurse = makeNurse({ scheduleKind });
      const s = scenario({
        startDate: isoDate('2026-12-20'),
        endDate: isoDate('2027-01-02'),
        nurses: [nurse],
        assignments: [assign(nurse.id, NIGHT_12, '2026-12-25', { holdoverMinutes: 60 })],
      });
      return costSchedule(
        s.schedule,
        christmas('clock', { holidayDates: new Set([isoDate('2026-12-26')]) }),
      ).assignments[0]!;
    };
    expect(cost('va_baylor').lines.find((l) => l.kind === 'holiday')).toMatchObject({
      hours: 1,
      amount: 25,
    });
    expect(cost('va_baylor').total).toBe(675);
    expect(cost('standard').total).toBe(850);
  });

  const MAJOR_DOUBLE = diff('major_holiday', 'multiplier', 2);
  const eveNight = () => {
    const nurse = makeNurse();
    return scenario({
      startDate: isoDate('2026-12-20'),
      endDate: isoDate('2027-01-02'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-12-24')],
    });
  };

  it('pays each date’s own holiday premium by the clock: ordinary Christmas Eve, major Christmas', () => {
    const [cost] = costSchedule(
      eveNight().schedule,
      christmas('clock', {
        differentials: [HOLIDAY, MAJOR_DOUBLE],
        holidayDates: new Set([isoDate('2026-12-24'), isoDate('2026-12-25')]),
        majorHolidayDates: new Set([isoDate('2026-12-25')]),
      }),
    ).assignments;
    // 5h on Christmas Eve at ×1.5: 5 × 25 = 125. 7h on Christmas, major, ×2: 7 × 50 = 350.
    // 600 + 125 + 350 = 1075.
    expect(lineAmounts(cost!)).toMatchObject({ holiday: 125, major_holiday: 350 });
    expect(cost?.total).toBe(1075);
  });

  it('pays the clock holiday premium on base under additive stacking', () => {
    const priced = (premiumStacking: 'compound' | 'additive') =>
      costSchedule(
        eveNight().schedule,
        christmas('clock', { differentials: [NIGHT, HOLIDAY], premiumStacking }),
      ).assignments[0]!;
    // Night $4.50 flat: 12 × 4.5 = 54. The 7h on Christmas at ×1.5: additive on the $50 base,
    // 7 × 25 = 175 → 600 + 54 + 175 = 829; compound on the $54.50 night rate, 7 × 27.25 =
    // 190.75 → 844.75.
    expect(priced('additive').total).toBe(829);
    expect(priced('compound').total).toBe(844.75);
  });

  it('puts the clock holiday premium in the week’s regular rate for its overtime', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-12-20'),
      endDate: isoDate('2027-01-02'),
      nurses: [nurse],
      assignments: [
        ...['2026-12-21', '2026-12-22', '2026-12-23'].map((d) => assign(nurse.id, DAY_12, d)),
        assign(nurse.id, NIGHT_12, '2026-12-24'),
      ],
    });
    const night = costSchedule(s.schedule, christmas('clock', { overtimeRules: [WEEKLY_40] }))
      .assignments[3]!;
    // Week of 12-20: 48h. Straight dollars 4 × 600 + the night's 7h on Christmas × 25 = 175:
    // 2575, rate 2575 / 48 = 53.6458…. The night's last 8h are past 40:
    // 8 × 0.5 × 53.6458… = 214.583… → 214.58. Night 600 + 175 + 214.58 = 989.58.
    expect(night.overtimeHours).toBe(8);
    expect(night.total).toBe(989.58);
  });

  it('lets holiday pay cover only a Baylor nurse’s held minutes on the holiday by the clock', () => {
    // Saturday 12-26 a holiday. The Friday night into Saturday is a Baylor tour held to 08:00.
    // Daily overtime runs from minute 480 to 780. Holiday pay is the held hour's only (§ 7456(d)),
    // minutes 720–780, so only that hour is covered, though 300–780 is on the holiday. Additive:
    // premium 4 × 25 = 100 on minutes 480–720; held holiday 1 × 25. 650 + 25 + 100 = 775.
    const nurse = makeNurse({ scheduleKind: 'va_baylor' });
    const s = scenario({
      startDate: isoDate('2026-12-20'),
      endDate: isoDate('2027-01-02'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-12-25', { holdoverMinutes: 60 })],
    });
    const [cost] = costSchedule(
      s.schedule,
      christmas('clock', {
        holidayDates: new Set([isoDate('2026-12-26')]),
        holidayPayCoversOvertime: true,
        premiumStacking: 'additive',
        overtimeRules: [overtimeRule('daily', 8)],
      }),
    ).assignments;
    expect(cost?.overtimeHours).toBe(5);
    expect(cost?.lines.find((l) => l.kind === 'overtime')).toMatchObject({ hours: 4, amount: 100 });
    expect(cost?.total).toBe(775);
  });

  it('lets holiday pay cover only the overtime minutes worked on Christmas by the clock', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-12-20'),
      endDate: isoDate('2027-01-02'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-12-24')],
    });
    const [cost] = costSchedule(
      s.schedule,
      christmas('clock', {
        holidayPayCoversOvertime: true,
        overtimeRules: [overtimeRule('daily', 8)],
      }),
    ).assignments;
    // Daily overtime is minutes 480–720 (03:00–07:00 on the 25th), all inside the holiday minutes
    // 300–720, so it earns no premium but still counts. 600 + 7 × 25 = 775.
    expect(cost?.overtimeHours).toBe(4);
    expect(cost?.lines.some((l) => l.kind === 'overtime')).toBe(false);
    expect(cost?.total).toBe(775);
  });
});

describe('the regular rate of each window a shift is split across', () => {
  const nightTenPercent = differential('night', 'multiplier', 1.1);
  const leaveIn = (nurseId: string, hours: number) =>
    new Map([[nurseId, [{ nurseId, date: isoDate('2026-01-12'), hours }]]]);

  it('pays a Saturday night’s Sunday overtime on the new week’s regular rate', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, NIGHT_12, '2026-01-10'),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [nightTenPercent],
        overtimeRules: [WEEKLY_40],
        overtimeLeave: leaveIn(nurse.id, 40),
      }),
    );
    // The night is 12 × 55 = $660: 5h ($275) in the week of 01-04, 7h ($385) in the week of 01-11.
    // Week of 01-04: (600 + 275) / 17h = 51.47…, 17h, no overtime. Week of 01-11: 40h of leave
    // (not hours worked, so not in the rate), then the night's 7h, all over: rate 385 / 7 = 55.
    // Premium 7 × 0.5 × 55 = 192.50; night 660 + 192.50 = 852.50.
    const night = report.assignments[1]!;
    expect(night.overtimeHours).toBe(7);
    expect(night.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 7, rate: 27.5, amount: 192.5 },
    ]);
    expect(night.total).toBe(852.5);
  });

  it('puts the whole Saturday night’s pay in the week it starts when the unit counts by start', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-10'),
        assign(nurse.id, DAY_12, '2026-01-11', { isCharge: true }),
      ],
    });
    const report = costSchedule(
      s.schedule,
      ctx({
        payRates: [payRate(50)],
        differentials: [nightTenPercent, CHARGE],
        overtimeRules: [WEEKLY_40],
        overtimeLeave: leaveIn(nurse.id, 40),
        overtimeWindowAttribution: 'start',
      }),
    );
    // By start, the whole night and its $660 are the week of 01-04's. The week of 01-11 holds 40h
    // of leave and Sunday's charge twelve, 12 × 52.50 = $630, all over: rate 630 / 12 = 52.50,
    // premium 12 × 0.5 × 52.50 = 315. (By the clock its rate would take in the night's Sunday
    // $385: (385 + 630) / 19 = 53.42….)
    const [night, sunday] = report.assignments;
    expect(night?.overtimeHours).toBe(0);
    expect(sunday?.lines.filter((l) => l.kind === 'overtime')).toEqual([
      { kind: 'overtime', hours: 12, rate: 26.25, amount: 315 },
    ]);
  });

  it('refuses to price overtime in a window that has no hours worked', () => {
    // An overtime band always lies in a window holding its own shift's minutes; an empty window
    // means the attribution and the rate disagree, and $0 would hide it.
    expect(() => regularRateFrom(undefined)).toThrow(/no hours worked/);
    expect(() => regularRateFrom({ dollars: 0, minutes: 0 })).toThrow(/no hours worked/);
    // $2460 over 48h (2880 minutes) is $51.25.
    expect(regularRateFrom({ dollars: 2460, minutes: 2880 })).toBe(51.25);
  });
});
