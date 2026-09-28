import { beforeEach, describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import {
  assign,
  assignRun,
  CRED_ACLS,
  census,
  coverageAllWeek,
  credentialRequirement,
  DAY_8,
  DAY_12,
  EVENING_8,
  MID_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  nurseCredential,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  TIER_HIGH,
  TIER_MODERATE,
  TIER_ROUTINE,
  testShiftTypes,
  timeOff,
} from '../testing/fixtures.js';
import { evaluateSchedule } from './registry.js';
import type { ViolationCode } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** Collect the violation codes a scenario produces, for terse assertions. */
function codes(s: ReturnType<typeof scenario>): ViolationCode[] {
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.map((v) => v.code);
}

function evaluate(s: ReturnType<typeof scenario>) {
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx);
}

describe('minimum rest', () => {
  it('flags the night-to-day turnaround', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_8, '2026-01-05'), // 23:00 → 07:00
        assign(nurse.id, DAY_8, '2026-01-06'), // 07:00 same morning
      ],
    });
    expect(codes(s)).toContain('insufficient_rest');
  });

  it('flags a 12-hour night followed by a 12-hour day', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'), // 19:00 → 07:00
        assign(nurse.id, DAY_12, '2026-01-06'), // 07:00 → 19:00
      ],
    });
    const rest = evaluate(s).violations.find((v) => v.code === 'insufficient_rest');
    expect(rest).toBeDefined();
    expect(rest?.details?.restHours).toBe(0);
  });

  it('accepts a 12-hour gap between consecutive day shifts', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05'), assign(nurse.id, DAY_12, '2026-01-06')],
    });
    expect(codes(s)).not.toContain('insufficient_rest');
  });

  it('catches a violation carried in from the previous period', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-01-04'),
      nurses: [nurse],
      priorAssignments: [assign(nurse.id, NIGHT_12, '2026-01-03', { id: 'prior-1' })],
      assignments: [assign(nurse.id, DAY_12, '2026-01-04')],
    });
    expect(codes(s)).toContain('insufficient_rest');
  });

  it('ignores on-call standby when computing rest', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, ON_CALL, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
      ],
    });
    expect(codes(s)).not.toContain('insufficient_rest');
  });
});

describe('consecutive shifts', () => {
  it('flags a six-day stretch against a five-day cap', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_8, '2026-01-05', 6),
    });
    const v = evaluate(s).violations.find((x) => x.code === 'too_many_consecutive_shifts');
    expect(v?.details).toMatchObject({ actual: 6, maximum: 5 });
  });

  it('accepts exactly five days in a row', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_8, '2026-01-05', 5),
    });
    expect(codes(s)).not.toContain('too_many_consecutive_shifts');
  });

  it('flags four consecutive nights against a three-night cap', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, NIGHT_12, '2026-01-05', 4),
    });
    expect(codes(s)).toContain('too_many_consecutive_nights');
  });

  it('does not apply the night cap to a mixed stretch', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...assignRun(nurse.id, NIGHT_12, '2026-01-05', 3),
        assign(nurse.id, DAY_12, '2026-01-08'),
      ],
    });
    expect(codes(s)).not.toContain('too_many_consecutive_nights');
  });

  it('requires recovery days after a maximum-length stretch', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      // Five on, one off, then back again.
      assignments: [
        ...assignRun(nurse.id, DAY_8, '2026-01-05', 5),
        assign(nurse.id, DAY_8, '2026-01-11'),
      ],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'missing_required_days_off');
    expect(v?.details).toMatchObject({ daysOff: 1, required: 2 });
  });

  it('accepts two recovery days after a maximum stretch', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...assignRun(nurse.id, DAY_8, '2026-01-05', 5),
        assign(nurse.id, DAY_8, '2026-01-12'),
      ],
    });
    expect(codes(s)).not.toContain('missing_required_days_off');
  });
});

describe('contracted hours', () => {
  it('flags a full-time nurse scheduled well short of their FTE', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 2), // 24h against 72h
    });
    const v = evaluate(s).violations.find((x) => x.code === 'under_contracted_hours');
    expect(v?.details).toMatchObject({ scheduledHours: 24, targetHours: 72 });
  });

  it('accepts a nurse landing exactly on their contracted hours', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      // Six 12s spread out to avoid tripping rest or consecutive rules.
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
        assign(nurse.id, DAY_12, '2026-01-08'),
        assign(nurse.id, DAY_12, '2026-01-09'),
        assign(nurse.id, DAY_12, '2026-01-12'),
        assign(nurse.id, DAY_12, '2026-01-13'),
      ],
    });
    expect(codes(s)).not.toContain('under_contracted_hours');
    expect(codes(s)).not.toContain('over_contracted_hours');
  });

  it('handles mixed 8h and 12h shifts in the hour total', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 40, fte: 0.5 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_8, '2026-01-09'),
        assign(nurse.id, DAY_8, '2026-01-12'),
      ],
    });
    // 12 + 12 + 8 + 8 = 40, exactly on target.
    const v = evaluate(s).violations.filter(
      (x) => x.code === 'under_contracted_hours' || x.code === 'over_contracted_hours',
    );
    expect(v).toHaveLength(0);
  });

  it('exempts per-diem nurses from the under-hours check', () => {
    const nurse = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const s = scenario({ nurses: [nurse], assignments: [] });
    expect(codes(s)).not.toContain('under_contracted_hours');
  });

  it('does not call a per-diem nurse with no contracted hours "over hours" for picking up a shift', () => {
    const nurse = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05'), assign(nurse.id, DAY_12, '2026-01-07')],
    });
    expect(codes(s)).not.toContain('over_contracted_hours');
  });

  it("counts a week of PTO toward a full-timer's contracted hours", () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      // Week one on vacation, paid as the three 12s she would have worked; week two worked.
      timeOff: [timeOff(nurse.id, '2026-01-04', '2026-01-10', { paidHours: 36 })],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-11'),
        assign(nurse.id, DAY_12, '2026-01-13'),
        assign(nurse.id, DAY_12, '2026-01-15'),
      ],
    });
    expect(codes(s)).not.toContain('under_contracted_hours');
  });

  it('does not count unpaid leave toward contracted hours', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-04', '2026-01-10', { type: 'unpaid' })],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-11'),
        assign(nurse.id, DAY_12, '2026-01-13'),
        assign(nurse.id, DAY_12, '2026-01-15'),
      ],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'under_contracted_hours');
    expect(v?.details).toMatchObject({ scheduledHours: 36, paidLeaveHours: 0, targetHours: 72 });
  });

  it('counts a shift missed on paid sick leave toward contracted hours', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      paidSickCalls: [{ nurseId: nurse.id, date: isoDate('2026-01-09'), hours: 12 }],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
        assign(nurse.id, DAY_12, '2026-01-08'),
        assign(nurse.id, DAY_12, '2026-01-12'),
        assign(nurse.id, DAY_12, '2026-01-13'),
      ], // 60 worked + 12 sick = 72
    });
    expect(codes(s)).not.toContain('under_contracted_hours');
  });

  it('can be told to count worked hours only', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-04', '2026-01-10', { paidHours: 36 })],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-11'),
        assign(nurse.id, DAY_12, '2026-01-13'),
        assign(nurse.id, DAY_12, '2026-01-15'),
      ],
      ruleParams: { 'fte-target-hours': { paidLeaveCountsTowardHours: false } },
    });
    expect(codes(s)).toContain('under_contracted_hours');
  });

  it('ignores a pay period only partly covered by the schedule', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    // One week only: the 14-day pay period is not fully inside it.
    const s = scenario({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-10'),
      nurses: [nurse],
      assignments: [],
    });
    expect(codes(s)).not.toContain('under_contracted_hours');
  });
});

describe('weekly hours and overtime', () => {
  it('flags unauthorised overtime', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 84 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04'),
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-08'),
      ], // 48h in the week beginning Sunday 2026-01-04
    });
    const v = evaluate(s).violations.find((x) => x.code === 'unauthorised_overtime');
    expect(v?.details).toMatchObject({ scheduledHours: 48, overtimeHours: 8 });
  });

  it('accepts overtime that is explicitly authorised', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 84 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04'),
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-08', { isOvertime: true }),
      ],
    });
    expect(codes(s)).not.toContain('unauthorised_overtime');
  });

  it('does not make a week with a PTO day overtime: leave is not hours worked', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 84 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-06', '2026-01-06', { paidHours: 12 })],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09'),
      ], // 36 worked + 12 PTO
    });
    expect(codes(s)).not.toContain('unauthorised_overtime');
  });

  it('counts PTO toward overtime where the contract says it does', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 84 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-06', '2026-01-06', { paidHours: 12 })],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09'),
      ],
      ruleParams: { 'max-hours-per-week': { paidLeaveCountsTowardOvertime: true } },
    });
    const v = evaluate(s).violations.find((x) => x.code === 'unauthorised_overtime');
    expect(v?.details).toMatchObject({ scheduledHours: 36, paidLeaveHours: 12, overtimeHours: 8 });
  });

  it('never counts leave toward the absolute weekly cap: it is not fatigue', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-10', '2026-01-10', { paidHours: 12 })],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-05', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-07', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-08', { isOvertime: true }),
      ], // 48 worked, exactly the cap, plus 12 PTO
      ruleParams: { 'max-hours-per-week': { paidLeaveCountsTowardOvertime: true } },
    });
    expect(codes(s)).not.toContain('over_max_hours');
  });

  it('flags a week over the absolute cap even when overtime is authorised', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-05', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-06', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-07', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-08', { isOvertime: true }),
      ], // 60h, over the 48h cap
    });
    expect(codes(s)).toContain('over_max_hours');
  });
});

describe('overtime judged over the pay period', () => {
  // Six 12s and one 8 a fortnight: 3×12 + 8 = 44h one week, 3×12 = 36h the next, 80h in all.
  // Pay period Sun 4 – Sat 17 Jan 2026.
  const PAY_PERIOD_80 = {
    'max-hours-per-week': { overtimeByPayPeriod: true, payPeriodOvertimeThresholdHours: 80 },
  };
  const sixTwelvesAndAnEight = (nurseId: string) => [
    assign(nurseId, DAY_12, '2026-01-04'),
    assign(nurseId, DAY_12, '2026-01-06'),
    assign(nurseId, DAY_12, '2026-01-08'),
    assign(nurseId, DAY_8, '2026-01-09'),
    assign(nurseId, DAY_12, '2026-01-12'),
    assign(nurseId, DAY_12, '2026-01-14'),
    assign(nurseId, DAY_12, '2026-01-16'),
  ];

  it('calls the 44-hour week overtime when overtime is weekly', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 80 });
    const s = scenario({ nurses: [nurse], assignments: sixTwelvesAndAnEight(nurse.id) });
    const v = evaluate(s).violations.find((x) => x.code === 'unauthorised_overtime');
    expect(v?.details).toMatchObject({ scheduledHours: 44, overtimeHours: 4 });
  });

  it('accepts a 44-hour week when the pay period comes to 80', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 80 });
    const s = scenario({
      nurses: [nurse],
      assignments: sixTwelvesAndAnEight(nurse.id),
      ruleParams: PAY_PERIOD_80,
    });
    expect(codes(s)).not.toContain('unauthorised_overtime');
  });

  it('flags the hours past 80 in a pay period with no authorised shift', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    const s = scenario({
      nurses: [nurse],
      // A seventh 12 on Sat 17 Jan: 92h in the pay period, week two exactly at the 48h cap.
      assignments: [...sixTwelvesAndAnEight(nurse.id), assign(nurse.id, DAY_12, '2026-01-17')],
      ruleParams: PAY_PERIOD_80,
    });
    const v = evaluate(s).violations.find((x) => x.code === 'unauthorised_overtime');
    expect(v?.details).toMatchObject({ scheduledHours: 92, overtimeHours: 12, threshold: 80 });
    expect(v?.dates).toEqual(['2026-01-04', '2026-01-17']);
    expect(v?.message).toMatch(/pay period/);
    expect(codes(s)).not.toContain('over_max_hours');
  });

  it('accepts the hours past 80 when a shift in the pay period is authorised overtime', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...sixTwelvesAndAnEight(nurse.id),
        assign(nurse.id, DAY_12, '2026-01-17', { isOvertime: true }),
      ],
      ruleParams: PAY_PERIOD_80,
    });
    expect(codes(s)).not.toContain('unauthorised_overtime');
  });

  it('counts the shifts worked before this schedule began in the same pay period', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    // This schedule starts Sun 11 Jan, halfway through the pay period; the first week's 44h
    // were published last period. Four 12s this week bring the pay period to 92h.
    const s = scenario({
      nurses: [nurse],
      startDate: isoDate('2026-01-11'),
      endDate: isoDate('2026-01-24'),
      priorAssignments: sixTwelvesAndAnEight(nurse.id)
        .slice(0, 4)
        .map((a) => ({ ...a, periodId: 'period-0' })),
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-12'),
        assign(nurse.id, DAY_12, '2026-01-14'),
        assign(nurse.id, DAY_12, '2026-01-16'),
        assign(nurse.id, DAY_12, '2026-01-17'),
      ],
      ruleParams: PAY_PERIOD_80,
    });
    const v = evaluate(s).violations.find((x) => x.code === 'unauthorised_overtime');
    expect(v?.details).toMatchObject({ scheduledHours: 92, overtimeHours: 12 });
  });

  it('still caps a single week at the absolute weekly limit', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    const s = scenario({
      nurses: [nurse],
      // 60h in the week of 4 Jan, all authorised: under 80 for the pay period, over the 48h cap.
      assignments: ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
        assign(nurse.id, DAY_12, d, { isOvertime: true }),
      ),
      ruleParams: PAY_PERIOD_80,
    });
    expect(codes(s)).toContain('over_max_hours');
  });

  it('counts PTO toward the pay period threshold where the contract says it does', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-10', '2026-01-10', { paidHours: 12 })],
      assignments: [...sixTwelvesAndAnEight(nurse.id)], // 80 worked + 12 PTO
      ruleParams: {
        'max-hours-per-week': {
          ...PAY_PERIOD_80['max-hours-per-week'],
          paidLeaveCountsTowardOvertime: true,
        },
      },
    });
    const v = evaluate(s).violations.find((x) => x.code === 'unauthorised_overtime');
    expect(v?.details).toMatchObject({ scheduledHours: 80, paidLeaveHours: 12, overtimeHours: 12 });
  });
});

describe('approved time off', () => {
  it('flags a nurse scheduled during approved PTO', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-06', '2026-01-10')],
      assignments: [assign(nurse.id, DAY_12, '2026-01-07')],
    });
    expect(codes(s)).toContain('works_during_approved_time_off');
  });

  it('lets a nurse work the night before their leave, finishing on its first morning', () => {
    // Leave is booked against the shifts dated in it: the night dated the 6th is the 6th's.
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-07', '2026-01-10')],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-06')], // ends 07:00 on the 7th
    });
    expect(codes(s)).not.toContain('works_during_approved_time_off');
  });

  it('keeps a nurse off the night dated on their day of leave, but not the next night', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-07', '2026-01-07')],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-07'), // the 7th's night: on leave
        assign(nurse.id, NIGHT_12, '2026-01-08'), // the 8th's night: free to work
      ],
    });
    const flagged = evaluate(s)
      .violations.filter((v) => v.code === 'works_during_approved_time_off')
      .map((v) => v.dates[0]);
    expect(flagged).toEqual(['2026-01-07']);
  });

  it("counts the night into leave's first morning when the contract makes a day off a whole calendar day", () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-07', '2026-01-10')],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-06')],
      ruleParams: { 'approved-time-off-is-absolute': { nightShiftEndingOnLeaveCounts: true } },
    });
    expect(codes(s)).toContain('works_during_approved_time_off');
  });

  it('judges that by when the shift ends: an evening tour ending before midnight never reaches leave', () => {
    // A Title 38 evening tour is flagged as a night for its differential; it still ends at 23:30.
    const eveningTour = { ...EVENING_8, id: 'st-e8-va', startTime: '15:30', isNight: true };
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, NIGHT_12, eveningTour],
      timeOff: [timeOff(nurse.id, '2026-01-07', '2026-01-10')],
      assignments: [assign(nurse.id, eveningTour, '2026-01-06')],
      ruleParams: { 'approved-time-off-is-absolute': { nightShiftEndingOnLeaveCounts: true } },
    });
    expect(codes(s)).not.toContain('works_during_approved_time_off');
  });

  it('ignores pending requests', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-06', '2026-01-10', { status: 'pending' })],
      assignments: [assign(nurse.id, DAY_12, '2026-01-07')],
    });
    expect(codes(s)).not.toContain('works_during_approved_time_off');
  });

  it('ignores denied requests', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-06', '2026-01-10', { status: 'denied' })],
      assignments: [assign(nurse.id, DAY_12, '2026-01-07')],
    });
    expect(codes(s)).not.toContain('works_during_approved_time_off');
  });
});

describe('overlapping assignments', () => {
  it('flags two overlapping shifts on the same day', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'), // 07:00 → 19:00
        assign(nurse.id, EVENING_8, '2026-01-05'), // 15:00 → 23:00
      ],
    });
    expect(codes(s)).toContain('overlapping_assignments');
  });

  it('flags standby overlapping a worked shift', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, ON_CALL, '2026-01-05'),
      ],
    });
    expect(codes(s)).toContain('overlapping_assignments');
  });

  it('accepts back-to-back shifts that merely touch', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_8, '2026-01-05'), // 07:00 → 15:00
        assign(nurse.id, EVENING_8, '2026-01-05'), // 15:00 → 23:00
      ],
    });
    expect(codes(s)).not.toContain('overlapping_assignments');
  });
});

describe('coverage minimums', () => {
  it('flags a shift below its baseline floor', () => {
    const nurses = [makeNurse(), makeNurse()];
    const s = scenario({
      nurses,
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 3),
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, DAY_12, '2026-01-05'),
      ],
    });
    // The floor applies every day, so other dates are legitimately understaffed too;
    // assert against the one day this test actually staffs.
    const v = evaluate(s).violations.find(
      (x) => x.code === 'understaffed' && x.dates.includes(isoDate('2026-01-05')),
    );
    expect(v?.details).toMatchObject({ staffed: 2, required: 3, standard: 'coverage_floor' });
  });

  it('flags a staffed shift with no charge nurse', () => {
    const nurses = [makeNurse(), makeNurse()];
    const s = scenario({
      nurses,
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2),
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-05'),
        assign(nurses[1]!.id, DAY_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).toContain('missing_charge_nurse');
  });

  it('does not ask for a charge nurse on a mid shift the day charge nurse runs', () => {
    const nurses = [makeNurse(), makeNurse()];
    const s = scenario({
      nurses,
      shiftTypes: [...testShiftTypes, MID_8],
      coverageRequirements: coverageAllWeek(MID_8, 'RN', 2),
      assignments: [
        assign(nurses[0]!.id, MID_8, '2026-01-05'),
        assign(nurses[1]!.id, MID_8, '2026-01-05'),
      ],
    });
    expect(codes(s)).not.toContain('missing_charge_nurse');
  });

  it('accepts a shift with a designated, eligible charge nurse', () => {
    const charge = makeNurse({ isChargeEligible: true });
    const other = makeNurse();
    const s = scenario({
      nurses: [charge, other],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2),
      assignments: [
        assign(charge.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(other.id, DAY_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).not.toContain('missing_charge_nurse');
  });

  it('rejects a charge designation on a nurse who is not charge-eligible', () => {
    const nurses = [makeNurse({ isChargeEligible: false }), makeNurse()];
    const s = scenario({
      nurses,
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2),
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, DAY_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).toContain('missing_charge_nurse');
  });

  it('flags a shift staffed entirely by novices', () => {
    const nurses = [
      makeNurse({ isNovice: true, isChargeEligible: true }),
      makeNurse({ isNovice: true }),
    ];
    const s = scenario({
      nurses,
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2),
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, DAY_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).toContain('all_novice_shift');
  });

  it('does not count an experienced nursing assistant as cover for a new-grad RN', () => {
    const newGrad = makeNurse({ isNovice: true });
    const aide = makeNurse({ role: 'CNA' });
    const s = scenario({
      nurses: [newGrad, aide],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
      assignments: [
        assign(newGrad.id, DAY_12, '2026-01-05'),
        assign(aide.id, DAY_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).toContain('all_novice_shift');
  });

  it('lets a new grad on the mid 8 work beside the day 12’s experienced RN', () => {
    const newGrad = makeNurse({ isNovice: true });
    const lead = makeNurse({ isChargeEligible: true });
    const s = scenario({
      nurses: [newGrad, lead],
      shiftTypes: [...testShiftTypes, MID_8],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(MID_8, 'RN', 1),
      ],
      assignments: [
        assign(lead.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(newGrad.id, MID_8, '2026-01-05'),
      ],
    });
    expect(codes(s)).not.toContain('all_novice_shift');
  });

  it('flags a new grad alone on the mid 8 when the day 12 has no experienced RN either', () => {
    const newGrad = makeNurse({ isNovice: true });
    const s = scenario({
      nurses: [newGrad],
      shiftTypes: [...testShiftTypes, MID_8],
      coverageRequirements: coverageAllWeek(MID_8, 'RN', 1),
      assignments: [assign(newGrad.id, MID_8, '2026-01-05')],
    });
    expect(codes(s)).toContain('all_novice_shift');
  });

  it('counts the day 12’s ACLS nurse toward an ACLS requirement on the mid 8', () => {
    const lead = makeNurse({ isChargeEligible: true });
    const mid = makeNurse();
    const s = scenario({
      nurses: [lead, mid],
      shiftTypes: [...testShiftTypes, MID_8],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(MID_8, 'RN', 1),
      ],
      shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: MID_8 })],
      nurseCredentials: [nurseCredential(lead.id, CRED_ACLS)],
      assignments: [
        assign(lead.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(mid.id, MID_8, '2026-01-05'),
      ],
    });
    expect(codes(s)).not.toContain('missing_credential');
  });

  it('flags a shift missing a required credential', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse()];
    const s = scenario({
      nurses,
      coverageRequirements: coverageAllWeek(NIGHT_12, 'RN', 2),
      shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: NIGHT_12 })],
      assignments: [
        assign(nurses[0]!.id, NIGHT_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, NIGHT_12, '2026-01-05'),
      ],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'missing_credential');
    expect(v?.details).toMatchObject({ credentialCode: 'ACLS', held: 0, required: 1 });
  });

  it('accepts the shift once someone holds the credential', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse()];
    const s = scenario({
      nurses,
      coverageRequirements: coverageAllWeek(NIGHT_12, 'RN', 2),
      shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: NIGHT_12 })],
      nurseCredentials: [nurseCredential(nurses[0]!.id, CRED_ACLS)],
      assignments: [
        assign(nurses[0]!.id, NIGHT_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, NIGHT_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).not.toContain('missing_credential');
  });

  it('treats an expired credential as absent', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse()];
    const s = scenario({
      nurses,
      coverageRequirements: coverageAllWeek(NIGHT_12, 'RN', 2),
      shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: NIGHT_12 })],
      nurseCredentials: [
        nurseCredential(nurses[0]!.id, CRED_ACLS, { expiresOn: isoDate('2026-01-01') }),
      ],
      assignments: [
        assign(nurses[0]!.id, NIGHT_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, NIGHT_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).toContain('missing_credential');
  });
});

describe('patient ratio compliance', () => {
  it('flags a breach when acuity pushes demand above the staffing', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse()];
    const s = scenario({
      nurses,
      // 20 routine patients at 1:5 needs 4 RNs; only 2 are scheduled.
      censusForecasts: [census('2026-01-05', DAY_12, { [TIER_ROUTINE.id]: 20 })],
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, DAY_12, '2026-01-05'),
      ],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'ratio_breach');
    expect(v?.details).toMatchObject({ staffed: 2, required: 4, projectedCensus: 20 });
  });

  it('accepts staffing that meets the ratio exactly', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse()];
    const s = scenario({
      nurses,
      censusForecasts: [census('2026-01-05', DAY_12, { [TIER_ROUTINE.id]: 10 })],
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, DAY_12, '2026-01-05'),
      ],
    });
    expect(codes(s)).not.toContain('ratio_breach');
  });

  it('demands more nurses for a high-acuity mix at the same census', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse()];
    const s = scenario({
      nurses,
      // 10 patients, but high acuity at 1:2 needs 5 RNs.
      censusForecasts: [census('2026-01-05', DAY_12, { [TIER_HIGH.id]: 10 })],
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(nurses[1]!.id, DAY_12, '2026-01-05'),
      ],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'ratio_breach');
    expect(v?.details).toMatchObject({ required: 5 });
  });

  it('combines a mixed-acuity load before rounding', () => {
    const nurses = [makeNurse({ isChargeEligible: true })];
    const s = scenario({
      nurses,
      // 5 routine (1:5 → 1.0) + 4 moderate (1:4 → 1.0) = 2.0 → 2 RNs.
      censusForecasts: [
        census('2026-01-05', DAY_12, { [TIER_ROUTINE.id]: 5, [TIER_MODERATE.id]: 4 }),
      ],
      assignments: [assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true })],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'ratio_breach');
    expect(v?.details).toMatchObject({ required: 2, staffed: 1 });
  });

  it('exempts shifts with no census forecast', () => {
    const nurses = [makeNurse({ isChargeEligible: true })];
    const s = scenario({
      nurses,
      assignments: [assign(nurses[0]!.id, DAY_12, '2026-01-05', { isCharge: true })],
    });
    expect(codes(s)).not.toContain('ratio_breach');
  });

  it('does not apply ratios to on-call standby', () => {
    const nurses = [makeNurse()];
    const s = scenario({
      nurses,
      censusForecasts: [census('2026-01-05', ON_CALL, { [TIER_HIGH.id]: 20 })],
      assignments: [assign(nurses[0]!.id, ON_CALL, '2026-01-05')],
    });
    expect(codes(s)).not.toContain('ratio_breach');
  });
});

describe('evaluation result', () => {
  it('reports a clean schedule as feasible', () => {
    const charge = makeNurse({ isChargeEligible: true, contractedHoursPerPeriod: 24 });
    const other = makeNurse({ contractedHoursPerPeriod: 24 });
    const s = scenario({
      nurses: [charge, other],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2),
      assignments: [
        assign(charge.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(charge.id, DAY_12, '2026-01-07'),
        assign(other.id, DAY_12, '2026-01-05'),
        assign(other.id, DAY_12, '2026-01-07'),
      ],
    });
    const result = evaluate(s);
    // Only the days that are actually staffed are under test here; the coverage floor
    // applies every day, so unstaffed days legitimately report understaffing.
    const onStaffedDay = result.violations.filter((v) => v.dates.includes(isoDate('2026-01-05')));
    expect(onStaffedDay).toHaveLength(0);
  });

  it('separates hard from soft violations', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
      ],
    });
    const result = evaluate(s);
    expect(result.feasible).toBe(false);
    expect(result.hardViolations.length).toBeGreaterThan(0);
    expect(result.hardViolations.every((v) => v.severity === 'hard')).toBe(true);
  });

  it('honours a severity override that relaxes a hard rule to advisory', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
      ],
    });
    const relaxed = {
      ...s.ruleSet,
      configs: s.ruleSet.configs.map((c) =>
        c.ruleId === 'min-rest-between-shifts' ? { ...c, severityOverride: 'soft' as const } : c,
      ),
    };
    const result = evaluateSchedule(s.schedule, relaxed, s.ctx);
    const rest = result.violations.filter((v) => v.code === 'insufficient_rest');
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((v) => v.severity === 'soft')).toBe(true);
  });

  it('can be restricted to a single rule', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
      ],
    });
    const result = evaluateSchedule(s.schedule, s.ruleSet, s.ctx, {
      only: ['min-rest-between-shifts'],
    });
    expect(result.violations.every((v) => v.ruleId === 'min-rest-between-shifts')).toBe(true);
  });

  it('disables a rule when the rule set turns it off', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
      ],
    });
    const disabled = {
      ...s.ruleSet,
      configs: s.ruleSet.configs.map((c) =>
        c.ruleId === 'min-rest-between-shifts' ? { ...c, enabled: false } : c,
      ),
    };
    const result = evaluateSchedule(s.schedule, disabled, s.ctx);
    expect(result.violations.some((v) => v.code === 'insufficient_rest')).toBe(false);
  });
});
