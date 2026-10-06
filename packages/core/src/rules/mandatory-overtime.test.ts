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
