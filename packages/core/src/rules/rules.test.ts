import { beforeEach, describe, expect, it } from 'vitest';

import type { RatioRule } from '../domain/entities.js';
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
import { RuleParamsError } from './param-validation.js';
import { evaluateSchedule, resolveConfigsUnchecked } from './registry.js';
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
    expect(rest).toMatchObject({ details: { restHours: 0 } });
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

  it('gives the longer after-night rest only after a night tour, not an evening paid as one', () => {
    const eveningTour = { ...EVENING_8, id: 'st-e8-va', startTime: '15:30', isNight: true };
    const ruleParams = { 'min-rest-between-shifts': { minRestHoursAfterNight: 24 } };
    const nurse = makeNurse();
    // 23:30 Mon → 15:30 Tue is 16 hours: over the base 10, and the after-night 24 must not apply.
    const evenings = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, NIGHT_12, eveningTour],
      ruleParams,
      assignments: [
        assign(nurse.id, eveningTour, '2026-01-05'),
        assign(nurse.id, eveningTour, '2026-01-06'),
      ],
    });
    expect(codes(evenings)).not.toContain('insufficient_rest');
    // 07:00 Tue → 19:00 Tue is 12 hours, short of the 24 owed after a real night.
    const nights = scenario({
      nurses: [nurse],
      ruleParams,
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, NIGHT_12, '2026-01-06'),
      ],
    });
    const rest = evaluate(nights).violations.filter((v) => v.code === 'insufficient_rest');
    expect(rest).toHaveLength(1);
    expect(rest[0]!.details).toMatchObject({ requiredHours: 24, afterNightShift: true });
  });

  it('measures rest from the end of a night, not from a short shift nested inside it', () => {
    const SHORT_2 = {
      ...DAY_8,
      id: 'st-s2',
      name: 'Short 2',
      abbreviation: 'S2',
      startTime: '20:00',
      durationHours: 2,
    };
    const LATE_DAY_8 = { ...DAY_8, id: 'st-ld8', startTime: '09:00' };
    const nurse = makeNurse();
    const night = assign(nurse.id, NIGHT_12, '2026-01-05'); // 19:00 Mon → 07:00 Tue
    const short = assign(nurse.id, SHORT_2, '2026-01-05'); // 20:00 → 22:00 Mon, inside the night
    const lateDay = assign(nurse.id, LATE_DAY_8, '2026-01-06'); // 09:00 Tue
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [...testShiftTypes, SHORT_2, LATE_DAY_8],
      assignments: [night, short, lateDay],
    });
    const found = evaluate(s).violations;
    // The night ends 07:00 Tue and the late day starts 09:00 Tue: 2 hours, short of 10. The short
    // shift's 22:00 end is not where the nurse's rest begins.
    const rest = found.filter((v) => v.code === 'insufficient_rest');
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({
      assignmentIds: [night.id, lateDay.id],
      details: { restHours: 2 },
    });
    // The short shift inside the night is a double booking in its own right.
    expect(found.filter((v) => v.code === 'overlapping_assignments')).toHaveLength(1);
  });

  it('asks for the after-night rest when a night and a short shift end at the same minute', () => {
    const EARLY_3 = { ...DAY_8, id: 'st-e3', startTime: '04:00', durationHours: 3 };
    const nurse = makeNurse();
    const monNight = assign(nurse.id, NIGHT_12, '2026-01-05'); // 19:00 Mon → 07:00 Tue
    const early = assign(nurse.id, EARLY_3, '2026-01-06'); // 04:00 → 07:00 Tue, a day tour
    const tueNight = assign(nurse.id, NIGHT_12, '2026-01-06'); // 19:00 Tue
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [...testShiftTypes, EARLY_3],
      ruleParams: { 'min-rest-between-shifts': { minRestHoursAfterNight: 24 } },
      assignments: [monNight, early, tueNight],
    });
    // Both the night and the early shift end 07:00 Tue; the night is owed 24 hours, the early
    // shift 10, so 24 applies. 07:00 → 19:00 Tue is 12 hours.
    const rest = evaluate(s).violations.filter((v) => v.code === 'insufficient_rest');
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({
      assignmentIds: [monNight.id, tueNight.id],
      details: { requiredHours: 24, restHours: 12 },
    });
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

  it('accepts three nights followed by a day: the run of nights is three', () => {
    // The boundary: nights 5, 6, 7 are a run of 3, at the cap of 3; the day on the 8th is not a
    // night and does not lengthen it.
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

  it('counts four nights after a day shift against a three-night cap', () => {
    // Night dates 6, 7, 8, 9 Jan: a run of 4 > 3. The whole stretch is 5 days (Mon–Fri) <= 5,
    // so the days-in-a-row cap has nothing to say.
    const nurse = makeNurse();
    const day = assign(nurse.id, DAY_12, '2026-01-05');
    const s = scenario({
      nurses: [nurse],
      assignments: [day, ...assignRun(nurse.id, NIGHT_12, '2026-01-06', 4)],
    });
    const found = evaluate(s).violations.filter((v) => v.code === 'too_many_consecutive_nights');
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toEqual({ actual: 4, maximum: 3 });
    expect(found[0]!.dates).toEqual(['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']);
    expect(found[0]!.assignmentIds).not.toContain(day.id);
    expect(codes(s)).not.toContain('too_many_consecutive_shifts');
  });

  it('counts four nights before a day shift against a three-night cap', () => {
    // Night dates 5–8 Jan: a run of 4 > 3. (The Friday day after the Thursday night is also a
    // 0-hour turnaround; that finding belongs to the rest rule.)
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        ...assignRun(nurse.id, NIGHT_12, '2026-01-05', 4),
        assign(nurse.id, DAY_12, '2026-01-09'),
      ],
    });
    const found = evaluate(s).violations.filter((v) => v.code === 'too_many_consecutive_nights');
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toMatchObject({ actual: 4 });
  });

  it('judges two runs of three nights split by a day shift as two runs, each within the cap', () => {
    // Nights 5, 6, 7; day 8; nights 9, 10, 11. Night runs [3, 3], each <= 3; the stretch is
    // 7 days <= 7.
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      ruleParams: { 'max-consecutive-shifts': { maxConsecutiveShifts: 7 } },
      assignments: [
        ...assignRun(nurse.id, NIGHT_12, '2026-01-05', 3),
        assign(nurse.id, DAY_12, '2026-01-08'),
        ...assignRun(nurse.id, NIGHT_12, '2026-01-09', 3),
      ],
    });
    expect(codes(s)).not.toContain('too_many_consecutive_nights');
  });

  it('counts nights carried in from the last schedule', () => {
    // Prior nights Fri 2 and Sat 3, in-period nights Sun 4 and Mon 5: one run of 2–5 Jan, 4 > 3.
    const nurse = makeNurse();
    const inPeriod = assignRun(nurse.id, NIGHT_12, '2026-01-04', 2);
    const s = scenario({
      nurses: [nurse],
      priorAssignments: [
        assign(nurse.id, NIGHT_12, '2026-01-02', { periodId: 'prev' }),
        assign(nurse.id, NIGHT_12, '2026-01-03', { periodId: 'prev' }),
      ],
      assignments: inPeriod,
    });
    const found = evaluate(s).violations.filter((v) => v.code === 'too_many_consecutive_nights');
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toMatchObject({ actual: 4 });
    expect(found[0]!.assignmentIds).toEqual(inPeriod.map((a) => a.id));
  });

  it('does not count a night on call toward the night cap, even where on-call counts as work', () => {
    // Worked nights 5, 6, 7 and standby 19:00 on the 8th. Standby never makes a night date, so the
    // run is 5–7, 3 <= 3. On-call counting as work only lengthens the stretch: 4 days <= 5.
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      ruleParams: { 'max-consecutive-shifts': { onCallCountsAsWork: true } },
      assignments: [
        ...assignRun(nurse.id, NIGHT_12, '2026-01-05', 3),
        assign(nurse.id, ON_CALL, '2026-01-08'),
      ],
    });
    expect(codes(s)).not.toContain('too_many_consecutive_nights');
  });

  it('does not count a Title 38 evening tour paid as a night toward the night cap', () => {
    // 15:30 is minute 930, inside [720, 1080): an evening tour, whatever its pay flag.
    const eveningTour = { ...EVENING_8, id: 'st-e8-va', startTime: '15:30', isNight: true };
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [DAY_12, NIGHT_12, eveningTour],
      assignments: assignRun(nurse.id, eveningTour, '2026-01-05', 4),
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

  it('treats a nurse scheduled short of their hours as a decision to make, not a breach', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 2),
    });
    const v = evaluate(s).violations.find((x) => x.code === 'under_contracted_hours');
    expect(v?.severity).toBe('soft');
  });

  it('still refuses to schedule a nurse past their contract: over hours stays a breach', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 24 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09'),
      ],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'over_contracted_hours');
    expect(v?.severity).toBe('hard');
  });

  it('lets a nurse work a shift marked as authorised overtime past her contract', () => {
    // Seven 12s is 84h; the Jan 11 shift is authorised overtime, so 84 − 12 = 72 straight-time
    // hours against 72 contracted, within the 4h tolerance.
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09'),
        assign(nurse.id, DAY_12, '2026-01-11', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-13'),
        assign(nurse.id, DAY_12, '2026-01-15'),
        assign(nurse.id, DAY_12, '2026-01-17'),
      ],
    });
    expect(codes(s)).not.toContain('over_contracted_hours');
  });

  it('still refuses straight-time hours past the contract when one shift is overtime', () => {
    // Eight 12s is 96h, 12 of it authorised overtime: 84 straight-time hours, 12 over the 72.
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const straight = ['2026-01-04', '2026-01-05', '2026-01-07', '2026-01-09'].map((d) =>
      assign(nurse.id, DAY_12, d),
    );
    const overtime = assign(nurse.id, DAY_12, '2026-01-11', { isOvertime: true });
    const later = ['2026-01-13', '2026-01-15', '2026-01-17'].map((d) =>
      assign(nurse.id, DAY_12, d),
    );
    const s = scenario({ nurses: [nurse], assignments: [...straight, overtime, ...later] });
    const over = evaluate(s).violations.filter((x) => x.code === 'over_contracted_hours');
    expect(over).toHaveLength(1);
    expect(over[0]!.amount).toBe(12);
    expect(over[0]!.details).toMatchObject({ authorisedOvertimeHours: 12, deltaHours: 12 });
    expect([...over[0]!.assignmentIds].sort()).toEqual(
      [...straight, ...later].map((a) => a.id).sort(),
    );
    expect(over[0]!.message).toContain('(12h of it authorised overtime), 12h over');
  });

  it('does not call a nurse short for hours she worked as overtime', () => {
    // Five 12s is 60h; the overtime shift on Jan 11 makes 72, on target.
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09'),
        assign(nurse.id, DAY_12, '2026-01-11', { isOvertime: true }),
        assign(nurse.id, DAY_12, '2026-01-13'),
        assign(nurse.id, DAY_12, '2026-01-15'),
      ],
    });
    expect(codes(s)).not.toContain('under_contracted_hours');
  });

  it('does not call a nurse over contract for being held over: they were not scheduled past it', () => {
    // Six 12s and a 2h holdover is 74h worked against 72h contracted. With the tolerance at 0,
    // only counting the holdover would breach; the 72 scheduled hours sit exactly on target.
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-12'),
        assign(nurse.id, DAY_12, '2026-01-13'),
        assign(nurse.id, DAY_12, '2026-01-14', { holdoverMinutes: 120, holdoverMandated: true }),
      ],
      ruleParams: { 'fte-target-hours': { overToleranceHours: 0, underToleranceHours: 0 } },
    });
    expect(codes(s)).not.toContain('over_contracted_hours');
    expect(codes(s)).not.toContain('under_contracted_hours');
  });

  it('lets a contract that guarantees full hours mark a shortfall as a breach', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 2),
    });
    const ruleSet = {
      ...s.ruleSet,
      configs: s.ruleSet.configs.map((c) =>
        c.ruleId === 'fte-target-hours' ? { ...c, severityOverride: 'hard' as const } : c,
      ),
    };
    const v = evaluateSchedule(s.schedule, ruleSet, s.ctx).violations.find(
      (x) => x.code === 'under_contracted_hours',
    );
    expect(v?.severity).toBe('hard');
  });

  it("says how short in whole hours and the pay period's dates, as a manager reads them", () => {
    const nurse = makeNurse({
      firstName: 'Nicole',
      lastName: 'Brown',
      contractedHoursPerPeriod: 72,
      fte: 0.9,
    });
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 2),
    });
    const v = evaluate(s).violations.find((x) => x.code === 'under_contracted_hours');
    // Pay period Sunday 4 – Saturday 17 January 2026; 24h worked against 72h.
    expect(v?.message).toBe(
      'Nicole Brown is scheduled 24h in the pay period Sun Jan 4 – Sat Jan 17, 48h short of ' +
        'their contracted 72h (0.9 FTE).',
    );
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

  it('exempts a per-diem nurse with a contract from the under-hours check', () => {
    // A non-zero contract, or the check returns early before the exemption list is read.
    const nurse = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 24 });
    const s = scenario({ nurses: [nurse], assignments: [] });
    expect(codes(s)).not.toContain('under_contracted_hours');
  });

  it('flags the same contract short for a full-time nurse', () => {
    const nurse = makeNurse({ employmentType: 'full_time', contractedHoursPerPeriod: 24 });
    const s = scenario({ nurses: [nurse], assignments: [] });
    const v = evaluate(s).violations.find((x) => x.code === 'under_contracted_hours');
    expect(v).toBeDefined();
    expect(v!.details?.deltaHours).toBeCloseTo(-24, 4);
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

  it('does not call a week unauthorised overtime when the extra 6 hours were a holdover', () => {
    // 36h scheduled plus a 6h holdover is 42h worked; recording the holdover is the manager
    // authorising those hours, so no shift needs the overtime flag.
    const nurse = makeNurse({ contractedHoursPerPeriod: 84 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09', { holdoverMinutes: 360, holdoverMandated: true }),
      ],
    });
    expect(codes(s)).not.toContain('unauthorised_overtime');
  });

  it('still flags 42 hours with no holdover and no authorised shift', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 84 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09'),
        assign(nurse.id, DAY_12, '2026-01-10'),
      ],
    });
    expect(codes(s)).toContain('unauthorised_overtime');
  });

  it('still refuses a holdover that takes the week past the absolute cap', () => {
    // Four 12s is 48h, exactly the cap; a 1h holdover makes 49h worked.
    const nurse = makeNurse({ contractedHoursPerPeriod: 120 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-04'),
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
        assign(nurse.id, DAY_12, '2026-01-09', { holdoverMinutes: 60, holdoverMandated: true }),
      ],
    });
    const v = evaluate(s).violations.find((x) => x.code === 'over_max_hours');
    expect(v?.details).toMatchObject({ scheduledHours: 49, maxHours: 48 });
    expect(v?.amount).toBe(1); // 49 − 48
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

  it('flags the two worked nights that overlap even when on-call beside them is allowed', () => {
    const nurse = makeNurse();
    const n12 = assign(nurse.id, NIGHT_12, '2026-01-05'); // 19:00 → 07:00
    const onCall = assign(nurse.id, ON_CALL, '2026-01-05'); // 19:00 → 07:00, standby
    const n8 = assign(nurse.id, NIGHT_8, '2026-01-05'); // 23:00 → 07:00
    const s = scenario({
      nurses: [nurse],
      ruleParams: { 'no-overlapping-assignments': { allowOnCallDuringShift: true } },
      assignments: [n12, onCall, n8],
    });
    // The two worked nights share 23:00–07:00; every pair with the on-call shift is exempt.
    const found = evaluate(s).violations.filter((v) => v.code === 'overlapping_assignments');
    expect(found).toHaveLength(1);
    expect(new Set(found[0]!.assignmentIds)).toEqual(new Set([n12.id, n8.id]));
  });

  it('reports every pair of a triple booking, not just neighbours', () => {
    const nurse = makeNurse();
    const n12 = assign(nurse.id, NIGHT_12, '2026-01-05');
    const onCall = assign(nurse.id, ON_CALL, '2026-01-05');
    const n8 = assign(nurse.id, NIGHT_8, '2026-01-05');
    const s = scenario({ nurses: [nurse], assignments: [n12, onCall, n8] });
    // All three share 23:00–07:00, so each of the three pairs is a double booking.
    const pairs = evaluate(s)
      .violations.filter((v) => v.code === 'overlapping_assignments')
      .map((v) => [...v.assignmentIds].sort().join('+'));
    expect(pairs).toHaveLength(3);
    expect(new Set(pairs)).toEqual(
      new Set([
        [n12.id, onCall.id].sort().join('+'),
        [n12.id, n8.id].sort().join('+'),
        [onCall.id, n8.id].sort().join('+'),
      ]),
    );
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

  it('counts a charge nurse without patients toward staffing but not toward the bedside load', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse(), makeNurse(), makeNurse()];
    const s = scenario({
      nurses,
      // 20 routine patients at 1:5 is 4 bedside RNs, plus a charge nurse who takes none: 5.
      // Four are scheduled, one of them charge, so 3 carry the 20 patients: 6.7 each.
      censusForecasts: [census('2026-01-05', DAY_12, { [TIER_ROUTINE.id]: 20 })],
      ratioStaffing: {
        chargeNurseTakesPatients: false,
        breakMinutesPerNurse: 0,
        chargeCoversBreaks: false,
      },
      assignments: nurses.map((n, i) => assign(n.id, DAY_12, '2026-01-05', { isCharge: i === 0 })),
    });
    const v = evaluate(s).violations.find((x) => x.code === 'ratio_breach');
    expect(v?.details).toMatchObject({ staffed: 4, required: 5, shortfall: 1 });
    expect(v?.message).toContain('3 at the bedside is 6.7 patients per nurse');
    expect(v?.message).toContain(
      'requires 5 (4 at the bedside and a charge nurse without patients)',
    );
  });

  it('names the break relief a ratio needs when the unit plans for breaks', () => {
    const nurses = [makeNurse({ isChargeEligible: true }), makeNurse(), makeNurse(), makeNurse()];
    const s = scenario({
      nurses,
      // 4 bedside RNs × 60 min = 240 minutes in a 600-minute break window: one relief.
      censusForecasts: [census('2026-01-05', DAY_12, { [TIER_ROUTINE.id]: 20 })],
      ratioStaffing: {
        chargeNurseTakesPatients: true,
        breakMinutesPerNurse: 60,
        chargeCoversBreaks: false,
      },
      assignments: nurses.map((n, i) => assign(n.id, DAY_12, '2026-01-05', { isCharge: i === 0 })),
    });
    const v = evaluate(s).violations.find((x) => x.code === 'ratio_breach');
    expect(v?.details).toMatchObject({ staffed: 4, required: 5 });
    expect(v?.message).toContain('requires 5 (4 at the bedside and 1 to relieve breaks)');
  });

  describe('a licensed-nurse ratio pooling RNs and LVNs', () => {
    const LICENSED: RatioRule = {
      id: 'ratio-licensed',
      unitId: 'unit-1',
      role: 'licensed',
      acuityTierId: null,
      maxPatientsPerNurse: 5,
      minRnShare: 0.5,
      active: true,
    };
    // 20 routine patients at a licensed 1:5: four licensed nurses, at least two of them RNs.
    function pooled(rns: number, lvns: number) {
      const nurses = [
        ...Array.from({ length: rns }, (_, i) => makeNurse({ isChargeEligible: i === 0 })),
        ...Array.from({ length: lvns }, () => makeNurse({ role: 'LPN' })),
      ];
      const s = scenario({
        nurses,
        ratioRules: [LICENSED],
        censusForecasts: [census('2026-01-05', DAY_12, { [TIER_ROUTINE.id]: 20 })],
        assignments: nurses.map((n, i) =>
          assign(n.id, DAY_12, '2026-01-05', { isCharge: i === 0 }),
        ),
      });
      return evaluate(s).violations.filter((v) => v.code === 'ratio_breach');
    }

    it('accepts two RNs and two LVNs', () => {
      expect(pooled(2, 2)).toEqual([]);
    });

    it('flags one RN among four licensed nurses as an RN short of the share', () => {
      const [v, ...rest] = pooled(1, 3);
      expect(rest).toEqual([]);
      expect(v?.details).toMatchObject({
        role: 'RN',
        staffed: 1,
        required: 2,
        shortfall: 1,
        standard: 'rn_share',
      });
      expect(v?.message).toContain('1 of 4 licensed nurses is an RN; at least 2 must be (50%)');
    });

    it('counts the RN the share needs once: one RN and one LVN are two nurses short, not three', () => {
      // Two more are needed and one must be an RN: the share says 1 RN, the pool 1 more of either.
      const breaches = pooled(1, 1);
      expect(
        breaches.map((v) => [v.details?.standard, v.details?.role, v.details?.shortfall]),
      ).toEqual([
        ['ratio', 'licensed', 1],
        ['rn_share', 'RN', 1],
      ]);
      expect(breaches[0]!.message).toContain('1 more of either after the RNs');
    });

    it('flags three licensed nurses as one short of the pooled ratio', () => {
      const [v, ...rest] = pooled(2, 1);
      expect(rest).toEqual([]);
      expect(v?.details).toMatchObject({ role: 'licensed', staffed: 3, required: 4, shortfall: 1 });
      expect(v?.message).toContain('3 licensed nurses (2 RNs, 1 LVN) is 6.7 patients per nurse');
    });
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
  it('calls a fully staffed day with its charge nurse legal', () => {
    const charge = makeNurse({ isChargeEligible: true, contractedHoursPerPeriod: 24 });
    const other = makeNurse({ contractedHoursPerPeriod: 24 });
    const s = scenario({
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-05'),
      nurses: [charge, other],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 2),
      assignments: [
        assign(charge.id, DAY_12, '2026-01-05', { isCharge: true }),
        assign(other.id, DAY_12, '2026-01-05'),
      ],
    });
    const result = evaluate(s);
    expect(result.feasible).toBe(true);
    expect(result.violations).toEqual([]);
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
    // N12 ends 07:00 Jan 6, D12 starts 07:00: 0 h rest against 10.
    expect(result.violations).toHaveLength(1);
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

describe('a rule set with an unusable setting', () => {
  // A blank "rest after a night" saved as null: the rule read `0 >= null` as enough rest.
  function blankRestAfterNights() {
    const nurse = makeNurse();
    return scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'), // 19:00 Mon → 07:00 Tue
        assign(nurse.id, DAY_12, '2026-01-06'), // 07:00 Tue: 0 h rest
      ],
      ruleParams: {
        'min-rest-between-shifts': { minRestHours: 10, minRestHoursAfterNight: null },
      },
    });
  }

  it('refuses to judge a night-to-day turnaround under a blank rest-after-nights', () => {
    const s = blankRestAfterNights();
    expect(() => evaluateSchedule(s.schedule, s.ruleSet, s.ctx)).toThrow(RuleParamsError);
    expect(() => evaluateSchedule(s.schedule, s.ruleSet, s.ctx)).toThrow(
      /Minimum rest after a night \(hours\): Enter a number\..*Open Settings › Rules/,
    );
  });

  it('still lets the Rules editor open that rule set to fix it', () => {
    const s = blankRestAfterNights();
    const rest = resolveConfigsUnchecked(s.ruleSet).find(
      (c) => c.ruleId === 'min-rest-between-shifts',
    );
    expect(rest?.params).toEqual({
      minRestHours: 10,
      minRestHoursAfterNight: null,
      onCallCountsAsWork: false,
    });
  });
});
