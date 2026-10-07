import { beforeEach, describe, expect, it } from 'vitest';
import type { OvertimeVolunteer } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
  UNIT_ID,
} from '../testing/fixtures.js';
import { mandatoryOvertimeRule } from './mandatory-overtime.js';
import { defaultRuleSet, resolveConfigs } from './registry.js';

beforeEach(() => resetFixtureCounters());

function volunteer(nurseId: string, startDate: string, endDate: string): OvertimeVolunteer {
  return {
    id: `ot-vol-${nurseId}-${startDate}`,
    unitId: UNIT_ID,
    nurseId,
    startDate: isoDate(startDate),
    endDate: isoDate(endDate),
  };
}

function judge(
  options: Parameters<typeof scenario>[0],
  params = mandatoryOvertimeRule.defaultParams,
) {
  const s = scenario(options);
  return mandatoryOvertimeRule.evaluate(s.schedule, params, s.ctx);
}

describe('no mandatory overtime', () => {
  const ana = () => makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz' });

  it('refuses an overtime shift the nurse never offered to work', () => {
    const violations = judge({
      nurses: [ana()],
      assignments: [assign('ana', DAY_12, '2026-01-08', { id: 'ot', isOvertime: true })],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'mandatory_overtime',
      severity: 'hard',
      nurseIds: ['ana'],
      assignmentIds: ['ot'],
      dates: ['2026-01-08'],
    });
    expect(violations[0]!.message).toContain('Ana Cruz');
    expect(violations[0]!.message).toContain('Thu Jan 8');
  });

  it('allows it when she offered overtime that week, last day included', () => {
    expect(
      judge({
        nurses: [ana()],
        assignments: [assign('ana', DAY_12, '2026-01-08', { isOvertime: true })],
        overtimeVolunteers: [volunteer('ana', '2026-01-05', '2026-01-08')],
      }),
    ).toEqual([]);
  });

  it('does not let an offer for another week cover this one', () => {
    const violations = judge({
      nurses: [ana()],
      assignments: [assign('ana', DAY_12, '2026-01-08', { isOvertime: true })],
      overtimeVolunteers: [volunteer('ana', '2026-01-11', '2026-01-17')],
    });
    expect(violations.map((v) => v.code)).toEqual(['mandatory_overtime']);
  });

  it('does not let another nurse’s offer cover hers', () => {
    const violations = judge({
      nurses: [ana(), makeNurse({ id: 'bo' })],
      assignments: [assign('ana', DAY_12, '2026-01-08', { isOvertime: true })],
      overtimeVolunteers: [volunteer('bo', '2026-01-04', '2026-01-17')],
    });
    expect(violations).toHaveLength(1);
  });

  it('allows an emergency recorded on the shift, unless the contract allows none', () => {
    const options = {
      nurses: [ana()],
      assignments: [
        assign('ana', DAY_12, '2026-01-08', {
          isOvertime: true,
          notes: 'emergency: two call-offs, no volunteers reached',
        }),
      ],
    };
    expect(judge(options)).toEqual([]);
    expect(
      judge(options, { ...mandatoryOvertimeRule.defaultParams, allowEmergencyNote: false }),
    ).toHaveLength(1);
  });

  it('says nothing of straight-time shifts or of last period’s overtime', () => {
    expect(
      judge({
        nurses: [ana()],
        assignments: [assign('ana', DAY_12, '2026-01-08')],
        priorAssignments: [assign('ana', DAY_12, '2026-01-02', { isOvertime: true })],
      }),
    ).toEqual([]);
  });

  it('starts switched off, in a new rule set and in one saved before it shipped', () => {
    const fresh = defaultRuleSet('unit-1');
    const configOf = (configs: { ruleId: string; enabled: boolean }[]) =>
      configs.find((c) => c.ruleId === mandatoryOvertimeRule.id);
    expect(configOf(fresh.configs)?.enabled).toBe(false);
    const older = {
      ...fresh,
      configs: fresh.configs.filter((c) => c.ruleId !== 'no-mandatory-overtime'),
    };
    expect(configOf(resolveConfigs(older))?.enabled).toBe(false);
  });

  describe('with a cap on the hours a nurse can be required to work (38 U.S.C. §7459)', () => {
    const vaCap = { ...mandatoryOvertimeRule.defaultParams, maxMandatedWeeklyHours: 40 };
    // The administrative workweek of Sun Jan 4 – Sat Jan 10 2026.
    const threeTwelves = () => [
      assign('ana', DAY_12, '2026-01-04'),
      assign('ana', DAY_12, '2026-01-05'),
      assign('ana', DAY_12, '2026-01-06'),
    ];

    it('lets a manager order an 8 into a week of two 12s, which comes to 32 hours', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              assign('ana', DAY_12, '2026-01-04'),
              assign('ana', DAY_12, '2026-01-05'),
              assign('ana', DAY_8, '2026-01-08', { isOvertime: true }),
            ],
          },
          vaCap,
        ),
      ).toEqual([]);
    });

    it('refuses an ordered 8 on top of three 12s, a 44-hour week', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            ...threeTwelves(),
            assign('ana', DAY_8, '2026-01-08', { id: 'ordered', isOvertime: true }),
          ],
        },
        vaCap,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        code: 'mandatory_overtime',
        assignmentIds: ['ordered'],
        details: { weekHours: 44, maxMandatedWeeklyHours: 40 },
      });
      expect(violations[0]!.message).toContain('44h');
    });

    it('allows the same 44-hour week when the nurse volunteered for the 8', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              ...threeTwelves(),
              assign('ana', DAY_8, '2026-01-08', { isOvertime: true }),
            ],
            overtimeVolunteers: [volunteer('ana', '2026-01-08', '2026-01-08')],
          },
          vaCap,
        ),
      ).toEqual([]);
    });

    it('does not count last Saturday’s 12 toward this week', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              assign('ana', DAY_12, '2026-01-05'),
              assign('ana', DAY_12, '2026-01-06'),
              assign('ana', DAY_8, '2026-01-08', { isOvertime: true }),
            ],
            priorAssignments: [assign('ana', DAY_12, '2026-01-03')],
          },
          vaCap,
        ),
      ).toEqual([]);
    });

    it('counts a 12 worked earlier in the same week before the period began', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_12, '2026-01-05'),
            assign('ana', DAY_12, '2026-01-06'),
            assign('ana', DAY_8, '2026-01-08', { isOvertime: true }),
          ],
          priorAssignments: [assign('ana', DAY_12, '2026-01-04')],
        },
        vaCap,
      );
      expect(violations.map((v) => v.details?.weekHours)).toEqual([44]);
    });

    it('holds a weekend-plan nurse to 24 required hours', () => {
      // Sat Jan 10 and Sun Jan 4 are her two weekend 12s; an ordered 8 on Wednesday makes 32.
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_12, '2026-01-04'),
            assign('ana', DAY_8, '2026-01-07', { isOvertime: true }),
            assign('ana', DAY_12, '2026-01-10'),
          ],
        },
        { ...vaCap, maxMandatedWeeklyHours: 24 },
      );
      expect(violations.map((v) => v.details?.weekHours)).toEqual([32]);
    });

    it('judges by a work week that starts on Monday when the contract says so', () => {
      // Mon Jan 5 – Sun Jan 11 holds only the 12s of the 5th and 6th and the ordered 8: 32h.
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              ...threeTwelves(),
              assign('ana', DAY_8, '2026-01-08', { isOvertime: true }),
            ],
          },
          { ...vaCap, workWeekStartsOn: 1 },
        ),
      ).toEqual([]);
    });

    it('does not count standby toward the hours a nurse was required to work', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              assign('ana', DAY_12, '2026-01-04'),
              assign('ana', DAY_12, '2026-01-05'),
              assign('ana', ON_CALL, '2026-01-06'),
              assign('ana', DAY_8, '2026-01-08', { isOvertime: true }),
            ],
          },
          vaCap,
        ),
      ).toEqual([]);
    });

    it('allows exactly 40 required hours', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              assign('ana', DAY_12, '2026-01-04'),
              assign('ana', DAY_12, '2026-01-05'),
              assign('ana', DAY_8, '2026-01-07', { isOvertime: true }),
              assign('ana', DAY_8, '2026-01-09'),
            ],
          },
          vaCap,
        ),
      ).toEqual([]);
    });

    it('counts a 12 on the week’s Saturday but not the next Sunday', () => {
      const week = (lastTwelve: string) => [
        assign('ana', DAY_12, '2026-01-05'),
        assign('ana', DAY_12, '2026-01-06'),
        assign('ana', DAY_8, '2026-01-08', { isOvertime: true }),
        assign('ana', DAY_12, lastTwelve),
      ];
      const saturday = judge({ nurses: [ana()], assignments: week('2026-01-10') }, vaCap);
      expect(saturday.map((v) => v.details?.weekHours)).toEqual([44]);
      expect(judge({ nurses: [ana()], assignments: week('2026-01-11') }, vaCap)).toEqual([]);
    });
  });

  describe('with holdovers: time kept past the end of the shift', () => {
    const base = mandatoryOvertimeRule.defaultParams;
    // 38 U.S.C. §7459(a): no more than 8 consecutive hours required, 12 on a compressed tour.
    const vaConsecutive = {
      ...base,
      maxMandatedWeeklyHours: 40,
      maxRequiredConsecutiveHours: 8,
      compressedTourConsecutiveHours: 12,
    };
    const stayed = (minutes: number, mandated: boolean | undefined, notes?: string) => ({
      id: 'held',
      holdoverMinutes: minutes,
      ...(mandated === undefined ? {} : { holdoverMandated: mandated }),
      ...(notes === undefined ? {} : { notes }),
    });

    it('refuses an 8-hour tour a nurse was required to stay 60 minutes past: 9 hours straight', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [assign('ana', DAY_8, '2026-01-08', stayed(60, true))],
        },
        { ...base, maxRequiredConsecutiveHours: 8 },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        code: 'mandatory_overtime',
        severity: 'hard',
        nurseIds: ['ana'],
        assignmentIds: ['held'],
        details: { stretchHours: 9, consecutiveLimit: 8 },
      });
      expect(violations[0]!.message).toContain('9h');
      expect(violations[0]!.message).toContain('8h');
    });

    it('allows exactly 8 hours straight for the same required 8-hour tour', () => {
      expect(
        judge(
          { nurses: [ana()], assignments: [assign('ana', DAY_8, '2026-01-08')] },
          { ...base, maxRequiredConsecutiveHours: 8 },
        ),
      ).toEqual([]);
    });

    it('refuses a 12-hour tour held 60 minutes on a compressed schedule: 13 is over 12', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [assign('ana', DAY_12, '2026-01-08', stayed(60, true))],
        },
        vaConsecutive,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]!.details).toMatchObject({ stretchHours: 13, consecutiveLimit: 12 });
    });

    it('lets a 12-hour tour run its 12 hours when nobody is held over', () => {
      expect(
        judge(
          { nurses: [ana()], assignments: [assign('ana', DAY_12, '2026-01-08')] },
          vaConsecutive,
        ),
      ).toEqual([]);
    });

    it('does not judge a holdover the nurse volunteered for', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              assign('ana', DAY_12, '2026-01-08', stayed(60, false)),
              assign('ana', DAY_8, '2026-01-10', { ...stayed(30, undefined), id: 'unflagged' }),
            ],
          },
          vaConsecutive,
        ),
      ).toEqual([]);
    });

    it('excuses a required holdover recorded as an emergency, unless the contract allows none', () => {
      const options = {
        nurses: [ana()],
        assignments: [
          assign('ana', DAY_12, '2026-01-08', stayed(60, true, 'Emergency: code blue')),
        ],
      };
      expect(judge(options, vaConsecutive)).toEqual([]);
      expect(judge(options, { ...vaConsecutive, allowEmergencyNote: false })).toHaveLength(1);
    });

    it('does not let an overtime offer excuse a holdover the hospital required', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [assign('ana', DAY_12, '2026-01-08', stayed(60, true))],
          overtimeVolunteers: [volunteer('ana', '2026-01-04', '2026-01-10')],
        },
        vaConsecutive,
      );
      expect(violations).toHaveLength(1);
    });

    it('counts back-to-back tours as one stretch when a holdover runs into the next', () => {
      // Day 8 07:00-15:00 held 60 minutes to 16:00; the Evening 8 starts at 15:00 and joins it,
      // so the stretch is 07:00-23:00 = 16h on a limit of 8.
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_8, '2026-01-08', stayed(60, true)),
            assign('ana', EVENING_8, '2026-01-08', { id: 'evening' }),
          ],
        },
        { ...base, maxRequiredConsecutiveHours: 8 },
      );
      expect(violations.map((v) => v.details?.stretchHours)).toEqual([16]);
    });

    it('reports one breach for a stretch with two required holdovers, naming both shifts', () => {
      // Day 8 held 60 minutes runs to 16:00; Evening 8 from 15:00 held 60 to 24:00: one 17h stretch.
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_8, '2026-01-08', { ...stayed(60, true), id: 'first' }),
            assign('ana', EVENING_8, '2026-01-08', { ...stayed(60, true), id: 'second' }),
          ],
        },
        { ...base, maxRequiredConsecutiveHours: 8 },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        assignmentIds: ['first', 'second'],
        details: { stretchHours: 17, consecutiveLimit: 8 },
      });
    });

    it('bans a required holdover outright when no cap is set, and says how long', () => {
      const violations = judge({
        nurses: [ana()],
        assignments: [assign('ana', DAY_12, '2026-03-02', stayed(90, true))],
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        code: 'mandatory_overtime',
        assignmentIds: ['held'],
        dates: ['2026-03-02'],
      });
      expect(violations[0]!.message).toContain('Ana Cruz');
      expect(violations[0]!.message).toContain('1h 30m');
      expect(violations[0]!.message).toContain('Day 12');
      expect(violations[0]!.message).toContain('Mon Mar 2');
    });

    it('bans a required 30-minute holdover but not a volunteered one, with no cap set', () => {
      const judged = (mandated: boolean) =>
        judge({
          nurses: [ana()],
          assignments: [assign('ana', DAY_8, '2026-01-08', stayed(30, mandated))],
        });
      expect(judged(true)).toHaveLength(1);
      expect(judged(false)).toEqual([]);
    });

    it('counts a required holdover toward the 40-hour week: three 12s and 5h is 41', () => {
      const week = (minutes: number) => [
        assign('ana', DAY_12, '2026-01-04'),
        assign('ana', DAY_12, '2026-01-05'),
        assign('ana', DAY_12, '2026-01-06', stayed(minutes, true)),
      ];
      const weekly = { ...base, maxMandatedWeeklyHours: 40 };
      const over = judge({ nurses: [ana()], assignments: week(300) }, weekly);
      expect(over).toHaveLength(1);
      expect(over[0]!.details).toMatchObject({ weekHours: 41, maxMandatedWeeklyHours: 40 });
      expect(judge({ nurses: [ana()], assignments: week(240) }, weekly)).toEqual([]);
    });

    it('reports a required holdover once for each cap it breaks', () => {
      // Three 12s and a 5h holdover on the last: 41h in the week and 17h straight on the day.
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_12, '2026-01-04'),
            assign('ana', DAY_12, '2026-01-05'),
            assign('ana', DAY_12, '2026-01-06', stayed(300, true)),
          ],
        },
        vaConsecutive,
      );
      expect(violations.map((v) => Object.keys(v.details ?? {}).sort())).toEqual([
        ['maxMandatedWeeklyHours', 'weekHours'],
        ['consecutiveLimit', 'stretchHours'],
      ]);
    });
  });

  describe('with limits that hold even in an emergency (Illinois, Rhode Island)', () => {
    const base = mandatoryOvertimeRule.defaultParams;
    const illinois = { ...base, emergencyMaxHoursPastShift: 4 };
    const rhodeIsland = { ...base, emergencyMaxConsecutiveHours: 12 };
    const stayed = (minutes: number, mandated: boolean | undefined, notes?: string) => ({
      id: 'held',
      holdoverMinutes: minutes,
      ...(mandated === undefined ? {} : { holdoverMandated: mandated }),
      ...(notes === undefined ? {} : { notes }),
    });
    const surge = 'Emergency: census surge';

    it('refuses an Illinois emergency holdover of 5 hours past the shift', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [assign('ana', DAY_12, '2026-03-02', stayed(300, true, surge))],
        },
        illinois,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        code: 'mandatory_overtime',
        severity: 'hard',
        nurseIds: ['ana'],
        assignmentIds: ['held'],
        dates: ['2026-03-02'],
        details: { hoursPastShift: 5, emergencyMaxHoursPastShift: 4 },
      });
      expect(violations[0]!.message).toContain('5h');
      expect(violations[0]!.message).toContain('Mon Mar 2');
      expect(violations[0]!.message).toContain('even in an emergency');
    });

    it('allows an Illinois emergency holdover of exactly 4 hours', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [assign('ana', DAY_12, '2026-03-02', stayed(240, true, surge))],
          },
          illinois,
        ),
      ).toEqual([]);
    });

    it('refuses a Rhode Island emergency holdover that makes 13 straight hours', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [assign('ana', DAY_12, '2026-03-02', stayed(60, true, surge))],
        },
        rhodeIsland,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]!.details).toMatchObject({
        stretchHours: 13,
        emergencyMaxConsecutiveHours: 12,
      });
      expect(violations[0]!.message).toContain('even in an emergency');
    });

    it('allows a Rhode Island emergency holdover that makes exactly 12 straight hours', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [assign('ana', DAY_8, '2026-03-02', stayed(240, true, surge))],
          },
          rhodeIsland,
        ),
      ).toEqual([]);
    });

    it('never judges a volunteered holdover against the emergency limits', () => {
      expect(
        judge(
          {
            nurses: [ana()],
            assignments: [
              assign('ana', DAY_12, '2026-03-02', stayed(300, false, surge)),
              assign('ana', DAY_12, '2026-03-04', { ...stayed(300, undefined), id: 'unflagged' }),
            ],
          },
          { ...illinois, emergencyMaxConsecutiveHours: 12 },
        ),
      ).toEqual([]);
    });

    it('reports a required holdover once when both the ban and the emergency limit catch it', () => {
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [assign('ana', DAY_12, '2026-03-02', stayed(300, true))],
        },
        illinois,
      );
      expect(violations).toHaveLength(1);
    });

    it('reports an emergency stretch once when two required holdovers make it too long', () => {
      // Day 8 held 60 to 16:00 joins Evening 8 from 15:00 held 60 to 24:00: one 17h stretch.
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_8, '2026-03-02', { ...stayed(60, true, surge), id: 'first' }),
            assign('ana', EVENING_8, '2026-03-02', { ...stayed(60, true, surge), id: 'second' }),
          ],
        },
        rhodeIsland,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]!.details).toMatchObject({ stretchHours: 17 });
    });

    it('reports a stretch once under VA limits when a required and an emergency holdover share it', () => {
      // Day 8 held 60 (required) joins Evening 8 held 60 (emergency): one 17h stretch.
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_8, '2026-03-02', { ...stayed(60, true), id: 'first' }),
            assign('ana', EVENING_8, '2026-03-02', { ...stayed(60, true, surge), id: 'second' }),
          ],
        },
        {
          ...base,
          maxRequiredConsecutiveHours: 8,
          compressedTourConsecutiveHours: 12,
          emergencyMaxConsecutiveHours: 12,
        },
      );
      expect(violations).toHaveLength(1);
    });

    it('counts last period’s night shift in the stretch but names only the in-period holdover', () => {
      // Night 12 of Sun Mar 1 ends 07:00 Mon, when the Day 12 begins: 12 + 12 + 1 = 25h straight.
      const violations = judge(
        {
          nurses: [ana()],
          assignments: [assign('ana', DAY_12, '2026-03-02', stayed(60, true, surge))],
          priorAssignments: [assign('ana', NIGHT_12, '2026-03-01', { id: 'last-period' })],
        },
        rhodeIsland,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        assignmentIds: ['held'],
        details: { stretchHours: 25, emergencyMaxConsecutiveHours: 12 },
      });
    });
  });
});

describe('required hours on the Baylor weekend plan', () => {
  // Week of Sun 4 Jan: a day 12 on Sunday and one on Saturday, held two hours past it — 26 hours.
  const week = (nurseId: string) => [
    assign(nurseId, DAY_12, '2026-01-04'),
    assign(nurseId, DAY_12, '2026-01-10', {
      id: `held-${nurseId}`,
      holdoverMinutes: 120,
      holdoverMandated: true,
    }),
  ];
  const VA = {
    ...mandatoryOvertimeRule.defaultParams,
    maxMandatedWeeklyHours: 40,
    baylorMaxMandatedWeeklyHours: 24,
  };

  it('refuses requiring a Baylor nurse to 26 hours when the plan caps it at 24', () => {
    const violations = judge(
      {
        nurses: [makeNurse({ id: 'bay', firstName: 'Bea', scheduleKind: 'va_baylor' })],
        assignments: week('bay'),
      },
      VA,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'mandatory_overtime',
      assignmentIds: ['held-bay'],
      details: { weekHours: 26, maxMandatedWeeklyHours: 24 },
    });
  });

  it('allows the same 26 hours for a standard nurse under the 40-hour cap', () => {
    expect(judge({ nurses: [makeNurse({ id: 'std' })], assignments: week('std') }, VA)).toEqual([]);
  });

  it('uses the weekly cap for a Baylor nurse when the plan has none of its own', () => {
    const { baylorMaxMandatedWeeklyHours: _none, ...weeklyOnly } = VA;
    expect(
      judge(
        {
          nurses: [makeNurse({ id: 'bay', scheduleKind: 'va_baylor' })],
          assignments: week('bay'),
        },
        weeklyOnly,
      ),
    ).toEqual([]);
  });
});

describe("California's 12-hour alternative workweek (Wage Order 5 § 3(B)(9)–(11))", () => {
  const ana = () => makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz' });
  const CA = {
    allowEmergencyNote: true,
    workWeekStartsOn: 0 as const,
    maxRequiredHoursIn24: 12,
    emergencyMaxHoursIn24: 16,
  };
  // Short call-in shifts that end at the next morning's 07:00 day shift.
  const EARLY_4 = { ...DAY_8, id: 'st-x4', name: 'Early 4', startTime: '03:00', durationHours: 4 };
  const EARLY_5 = { ...DAY_8, id: 'st-x5', name: 'Early 5', startTime: '02:00', durationHours: 5 };
  const LATE_5 = { ...DAY_8, id: 'st-l5', name: 'Late 5', startTime: '03:00', durationHours: 5 };
  const shiftTypes = [...testShiftTypes, EARLY_4, EARLY_5, LATE_5];
  const held = (minutes: number, notes?: string) => ({
    id: 'held',
    holdoverMinutes: minutes,
    holdoverMandated: true,
    ...(notes === undefined ? {} : { notes }),
  });
  const cno = 'Emergency: CNO declared';

  it('refuses holding a nurse an hour past her 12 without a declared emergency: 13 in 24', () => {
    const violations = judge(
      { nurses: [ana()], assignments: [assign('ana', DAY_12, '2026-01-08', held(60))] },
      CA,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'mandatory_overtime',
      severity: 'hard',
      nurseIds: ['ana'],
      assignmentIds: ['held'],
      details: { hoursIn24: 13, maxRequiredHoursIn24: 12 },
    });
    expect(violations[0]!.message).toContain('13h within 24 hours');
  });

  it('allows the same hour when the chief nursing officer has declared an emergency', () => {
    expect(
      judge(
        { nurses: [ana()], assignments: [assign('ana', DAY_12, '2026-01-08', held(60, cno))] },
        CA,
      ),
    ).toEqual([]);
  });

  it('refuses a declared emergency that holds her 5 hours past her 12: 17 in 24 is over 16', () => {
    const violations = judge(
      { nurses: [ana()], assignments: [assign('ana', DAY_12, '2026-01-08', held(300, cno))] },
      CA,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      assignmentIds: ['held'],
      details: { hoursIn24: 17, emergencyMaxHoursIn24: 16 },
    });
    expect(violations[0]!.message).toContain('even in an emergency');
  });

  it('refuses calling her back at 03:00 after 8 hours off: 16 hours from 07:00 to 07:00', () => {
    const night = (shift: typeof EARLY_4, notes?: string) =>
      judge(
        {
          nurses: [ana()],
          shiftTypes,
          assignments: [
            assign('ana', DAY_12, '2026-01-08', { id: 'day' }),
            assign('ana', shift, '2026-01-09', {
              id: 'early',
              isOvertime: true,
              ...(notes === undefined ? {} : { notes }),
            }),
          ],
        },
        CA,
      );
    const plain = night(EARLY_4);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({
      assignmentIds: ['early'],
      details: { hoursIn24: 16, maxRequiredHoursIn24: 12 },
    });
    // A declared emergency may run to exactly 16 in 24.
    expect(night(EARLY_4, cno)).toEqual([]);
    // 03:00-08:00 is 17 hours worked, but over 25: no 24 hours hold more than 16.
    expect(night(LATE_5, cno)).toEqual([]);
    // 02:00-07:00 after the day 12 puts all 17 inside 07:00 to 07:00.
    const longer = night(EARLY_5, cno);
    expect(longer).toHaveLength(1);
    expect(longer[0]).toMatchObject({
      assignmentIds: ['early'],
      details: { hoursIn24: 17, emergencyMaxHoursIn24: 16 },
    });
  });

  it('allows the 03:00 call-back when she offered to work overtime that day', () => {
    expect(
      judge(
        {
          nurses: [ana()],
          shiftTypes,
          assignments: [
            assign('ana', DAY_12, '2026-01-08'),
            assign('ana', EARLY_4, '2026-01-09', { isOvertime: true }),
          ],
          overtimeVolunteers: [volunteer('ana', '2026-01-09', '2026-01-09')],
        },
        CA,
      ),
    ).toEqual([]);
  });

  it('allows an extra 12 starting twelve hours after her last ends: never more than 12 in 24', () => {
    expect(
      judge(
        {
          nurses: [ana()],
          assignments: [
            assign('ana', DAY_12, '2026-01-08'),
            assign('ana', DAY_12, '2026-01-09', { isOvertime: true }),
          ],
        },
        CA,
      ),
    ).toEqual([]);
  });

  it('never adds a colleague’s double to a nurse’s 24 hours', () => {
    // Ana: 07:00-18:00 held 30 minutes, 11.5h in 24. Bo: Night 12 of Wed Jan 7 then the Day 12 of
    // Thu Jan 8, 24h in 24 but nothing required of him. Mixed together, Ana's 24 would hold 35.5.
    const DAY_11 = { ...DAY_12, id: 'st-d11', name: 'Day 11', durationHours: 11 };
    const anas = () => [assign('ana', DAY_11, '2026-01-08', held(30))];
    const both = judge(
      {
        nurses: [ana(), makeNurse({ id: 'bo' })],
        shiftTypes: [...shiftTypes, DAY_11],
        assignments: [
          ...anas(),
          assign('bo', NIGHT_12, '2026-01-07'),
          assign('bo', DAY_12, '2026-01-08'),
        ],
      },
      CA,
    );
    expect(both).toEqual([]);
    const alone = judge(
      { nurses: [ana()], shiftTypes: [...shiftTypes, DAY_11], assignments: anas() },
      CA,
    );
    expect(alone).toEqual(both);
  });

  it('counts the next day’s double once, not the night beyond it', () => {
    // Day 12 of Thu Jan 8 held 2h to 21:00 (the required time is 19:00-21:00), then Fri Jan 9 a
    // Late 12 08:00-20:00 and a Night 12 20:00-08:00. A window must reach 19:00-21:00 Thu, so it
    // starts after 19:01 Wed and before 21:00 Thu. From 07:00 Thu it holds all 14h of the held
    // day and none of Friday (08:00 is past 07:00); from 08:00 to 20:00 Thu the held day's
    // shrinking tail and the Late 12's growing head make 13; past 20:00 the night adds what the
    // tail loses, still 13. So 14 in 24, and Friday's two shifts are never both inside.
    const LATE_12 = { ...DAY_12, id: 'st-late12', name: 'Late 12', startTime: '08:00' };
    const violations = judge(
      {
        nurses: [ana()],
        shiftTypes: [...shiftTypes, LATE_12],
        assignments: [
          assign('ana', DAY_12, '2026-01-08', held(120)),
          assign('ana', LATE_12, '2026-01-09', { id: 'late' }),
          assign('ana', NIGHT_12, '2026-01-09', { id: 'night' }),
        ],
      },
      CA,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      assignmentIds: ['held'],
      details: { hoursIn24: 14, maxRequiredHoursIn24: 12 },
    });
  });

  it('counts last period’s night before a required holdover but names only this period’s shift', () => {
    // Night 12 of Wed Jan 7 19:00 to Thu 07:00, then the Day 12 held to 20:00: 25 hours on the
    // floor, of which any 24 (19:00 to 19:00, or 20:00 to 20:00) hold 24.
    const violations = judge(
      {
        nurses: [ana()],
        assignments: [assign('ana', DAY_12, '2026-01-08', held(60))],
        priorAssignments: [assign('ana', NIGHT_12, '2026-01-07', { id: 'last-period' })],
        startDate: isoDate('2026-01-08'),
      },
      CA,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      assignmentIds: ['held'],
      dates: ['2026-01-08'],
      details: { hoursIn24: 24, maxRequiredHoursIn24: 12 },
    });
  });
});
