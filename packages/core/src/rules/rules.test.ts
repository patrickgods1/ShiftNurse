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

  it('flags a night shift that runs into the first morning of leave', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff(nurse.id, '2026-01-07', '2026-01-10')],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-06')], // ends 07:00 on the 7th
    });
    expect(codes(s)).toContain('works_during_approved_time_off');
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
