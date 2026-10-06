import { beforeEach, describe, expect, it } from 'vitest';
import type { OvertimeVolunteer } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_8,
  DAY_12,
  makeNurse,
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
});
