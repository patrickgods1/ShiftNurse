/**
 * The schedule lives on a wall-clock timeline where every day is 1440 minutes, so the spring-
 * forward and fall-back Sundays must not move a rest gap or a work week by an hour. Expected
 * values are worked by hand: 2026-03-07 is a Saturday, the clocks jump on Sunday 2026-03-08.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import type { DstTransition } from '../schedule/real-minutes.js';
import {
  assign,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
  testShiftTypes,
} from '../testing/fixtures.js';
import { maxHoursIn24Rule } from './hours-in-24.js';
import { type LongStretchParams, longStretchRule } from './long-stretch.js';
import { type MandatoryOvertimeParams, mandatoryOvertimeRule } from './mandatory-overtime.js';
import { evaluateSchedule } from './registry.js';
import type { Rule } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const SPRING = { startDate: isoDate('2026-03-01'), endDate: isoDate('2026-03-14') };

function restViolations(s: ReturnType<typeof scenario>) {
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
    (v) => v.code === 'insufficient_rest',
  );
}

function withMinRest(hours: number) {
  return { 'min-rest-between-shifts': { minRestHours: hours } };
}

describe('rest across the spring-forward weekend', () => {
  it('gives a full day off between the Saturday night and Monday morning', () => {
    const nurse = makeNurse();
    for (const hours of [10, 12]) {
      const s = scenario({
        ...SPRING,
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-03-07'), // ends Sunday 07:00
          assign(nurse.id, DAY_12, '2026-03-09'), // Monday 07:00: 24h later
        ],
        ruleParams: withMinRest(hours),
      });
      expect(restViolations(s)).toEqual([]);
    }
  });

  it('counts twelve hours of rest before Sunday night, whatever the clocks did', () => {
    const nurse = makeNurse();
    const build = (hours: number) =>
      scenario({
        ...SPRING,
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-03-07'), // ends Sunday 07:00
          assign(nurse.id, NIGHT_12, '2026-03-08'), // starts Sunday 19:00
        ],
        ruleParams: withMinRest(hours),
      });
    expect(restViolations(build(12))).toEqual([]);
    const flagged = restViolations(build(13));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.details?.restHours).toBe(12);
  });

  it('keeps a lookback night from the prior period in the rest maths', () => {
    const nurse = makeNurse();
    const night = assign(nurse.id, NIGHT_12, '2026-03-07', { id: 'prior-night' });
    const day = assign(nurse.id, DAY_12, '2026-03-08', { id: 'in-period-day' });
    const s = scenario({
      startDate: isoDate('2026-03-08'),
      endDate: isoDate('2026-03-21'),
      nurses: [nurse],
      priorAssignments: [night],
      assignments: [day],
    });
    const rest = restViolations(s);
    expect(rest).toHaveLength(1);
    expect(rest[0]?.details?.restHours).toBe(0);
    expect(rest[0]?.assignmentIds).toEqual(['in-period-day']);
    // One finding for the pair, not a second one against the lookback night itself.
    expect(rest[0]?.dates).toEqual([isoDate('2026-03-08')]);
  });
});

describe('rest across the fall-back weekend', () => {
  it('still counts twelve hours between the Saturday night and Sunday night', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-10-31'), // ends Sunday 11-01 07:00
        assign(nurse.id, NIGHT_12, '2026-11-01'),
      ],
      ruleParams: withMinRest(12),
    });
    expect(restViolations(s)).toEqual([]);
  });
});

// America/New_York's 2026 clock changes on the continuous wall timeline: 02:00 on Sun 2026-03-08
// (day 20520 × 1440 + 120) jumps to 03:00, and 02:00 on Sun 2026-11-01 (day 20758 × 1440 + 120)
// goes back to 01:00, so 01:00–02:00 that morning is worked twice.
const SPRING_FORWARD: DstTransition = { atMinute: 29_548_920, deltaMinutes: 60 };
const FALL_BACK: DstTransition = { atMinute: 29_891_640, deltaMinutes: -60 };
const FALL = { startDate: isoDate('2026-10-25'), endDate: isoDate('2026-11-07') };

// Starts at 17:00: seven hours after a fall-back night held to 10:00.
const LATE_8 = { ...DAY_8, id: 'st-l8', name: 'Late 8', abbreviation: 'L8', startTime: '17:00' };

function judge<P>(rule: Rule<P>, params: Partial<P>, options: ScenarioOptions) {
  const s = scenario({ shiftTypes: [...testShiftTypes, LATE_8], ...options });
  return rule.evaluate(s.schedule, { ...rule.defaultParams, ...params }, s.ctx);
}

const massachusetts: Partial<LongStretchParams> = {
  requiredOnly: false,
  maxConsecutiveHours: 16,
  emergencyLiftsCap: false,
  restAfterHours: 16,
  restOnlyPastThreshold: false,
  restHours: 8,
  honorsRestWaiver: false,
};

const pennsylvania: Partial<LongStretchParams> = {
  requiredOnly: false,
  restAfterHours: 12,
  restOnlyPastThreshold: true,
  restHours: 10,
  honorsRestWaiver: true,
};

describe('statutory hour caps count the hours actually worked', () => {
  it('flags the fall-back night under a twelve-hours-in-twenty-four limit: thirteen hours worked', () => {
    const nurse = makeNurse();
    const night = [assign(nurse.id, NIGHT_12, '2026-10-31')];
    // The window [19:00 Sat, 19:00 Sun) holds the whole night: 12 wall hours plus the repeated
    // 01:00–02:00, 780 real minutes, 13 h against 12.
    const flagged = judge(
      maxHoursIn24Rule,
      { maxHours: 12 },
      { ...FALL, nurses: [nurse], assignments: night, dstTransitions: [FALL_BACK] },
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.amount).toBe(1);
    expect(flagged[0]!.message).toContain('13h');
    // Without the clock change: 720 minutes, not past 720.
    expect(
      judge(maxHoursIn24Rule, { maxHours: 12 }, { ...FALL, nurses: [nurse], assignments: night }),
    ).toEqual([]);
  });

  it('leaves the spring-forward night under the twelve-hour limit', () => {
    const nurse = makeNurse();
    // 19:00 Sat 7 Mar to 07:00 Sun with 02:00–03:00 skipped: 660 real minutes, 11 h.
    expect(
      judge(
        maxHoursIn24Rule,
        { maxHours: 12 },
        {
          ...SPRING,
          nurses: [nurse],
          assignments: [assign(nurse.id, NIGHT_12, '2026-03-07')],
          dstTransitions: [SPRING_FORWARD],
        },
      ),
    ).toEqual([]);
  });

  it('counts a fall-back night held three hours as sixteen consecutive hours under Massachusetts’ cap', () => {
    const nurse = makeNurse();
    const assignments = [
      // 19:00 Sat to 10:00 Sun: 15 wall hours, 16 real with the repeated hour.
      assign(nurse.id, NIGHT_12, '2026-10-31', { holdoverMinutes: 180 }),
      // 17:00 Sun: 7 hours after 10:00.
      assign(nurse.id, LATE_8, '2026-11-01'),
    ];
    // 16 is not past the cap of 16, but 16 ≥ 16 earns 8 h of rest, and 7 h is short of it.
    const flagged = judge(longStretchRule, massachusetts, {
      ...FALL,
      nurses: [nurse],
      assignments,
      dstTransitions: [FALL_BACK],
    });
    expect(flagged.map((v) => v.code)).toEqual(['rest_after_long_stretch']);
    expect(flagged[0]!.details?.stretchHours).toBe(16);
    // Without the clock change: 15 h, no rest owed.
    expect(
      judge(longStretchRule, massachusetts, { ...FALL, nurses: [nurse], assignments }),
    ).toEqual([]);
  });

  it('owes Pennsylvania’s rest after the fall-back night: more than twelve consecutive hours', () => {
    const nurse = makeNurse();
    const assignments = [
      assign(nurse.id, NIGHT_12, '2026-10-31'), // ends 07:00 Sun, 13 real hours
      assign(nurse.id, EVENING_8, '2026-11-01'), // 15:00 Sun: 8 hours off
    ];
    // 13 > 12 earns 10 h of rest; 8 h is short of it.
    const flagged = judge(longStretchRule, pennsylvania, {
      ...FALL,
      nurses: [nurse],
      assignments,
      dstTransitions: [FALL_BACK],
    });
    expect(flagged.map((v) => v.code)).toEqual(['rest_after_long_stretch']);
    expect(flagged[0]!.details?.hoursOff).toBe(8);
    // Without: 12 is not more than 12.
    expect(judge(longStretchRule, pennsylvania, { ...FALL, nurses: [nurse], assignments })).toEqual(
      [],
    );
  });

  it('counts the fall-back night as thirteen required hours in California’s twelve-in-twenty-four', () => {
    const nurse = makeNurse();
    const params: Partial<MandatoryOvertimeParams> = { maxRequiredHoursIn24: 12 };
    // Overtime nobody volunteered for: all of it is required, 780 real minutes in [19:00, 19:00).
    const assignments = [assign(nurse.id, NIGHT_12, '2026-10-31', { isOvertime: true })];
    const flagged = judge(mandatoryOvertimeRule, params, {
      ...FALL,
      nurses: [nurse],
      assignments,
      dstTransitions: [FALL_BACK],
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.amount).toBe(1);
    expect(flagged[0]!.details?.hoursIn24).toBe(13);
    expect(judge(mandatoryOvertimeRule, params, { ...FALL, nurses: [nurse], assignments })).toEqual(
      [],
    );
  });

  it('counts the fall-back night as thirteen required hours toward the VA weekly cap', () => {
    const nurse = makeNurse();
    const params: Partial<MandatoryOvertimeParams> = { maxMandatedWeeklyHours: 36 };
    // Week of Sun 25 Oct: two day 12s (24 h) and the unvolunteered Saturday night (13 real h) is
    // 37 required hours against 36. On the wall clock it is 36, not past the cap.
    const assignments = [
      assign(nurse.id, DAY_12, '2026-10-26'),
      assign(nurse.id, DAY_12, '2026-10-27'),
      assign(nurse.id, NIGHT_12, '2026-10-31', { isOvertime: true }),
    ];
    const flagged = judge(mandatoryOvertimeRule, params, {
      ...FALL,
      nurses: [nurse],
      assignments,
      dstTransitions: [FALL_BACK],
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.amount).toBe(1);
    expect(flagged[0]!.details?.weekHours).toBe(37);
    expect(judge(mandatoryOvertimeRule, params, { ...FALL, nurses: [nurse], assignments })).toEqual(
      [],
    );
  });

  it('counts the fall-back night held an hour as fourteen hours straight against a compressed tour', () => {
    const nurse = makeNurse();
    const params: Partial<MandatoryOvertimeParams> = {
      maxRequiredConsecutiveHours: 8,
      compressedTourConsecutiveHours: 13,
    };
    // Held to 08:00 Sun as required: 13 wall hours, 14 real, past the 12-hour tour's 13.
    const assignments = [
      assign(nurse.id, NIGHT_12, '2026-10-31', { holdoverMinutes: 60, holdoverMandated: true }),
    ];
    const flagged = judge(mandatoryOvertimeRule, params, {
      ...FALL,
      nurses: [nurse],
      assignments,
      dstTransitions: [FALL_BACK],
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.details?.stretchHours).toBe(14);
    expect(judge(mandatoryOvertimeRule, params, { ...FALL, nurses: [nurse], assignments })).toEqual(
      [],
    );
  });
});
