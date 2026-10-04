import { beforeEach, describe, expect, it } from 'vitest';
import type { OvertimeVolunteer } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
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
    expect(judge(options, { allowEmergencyNote: false })).toHaveLength(1);
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
});
