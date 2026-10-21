/**
 * A float works on this unit only within her membership dates, by hand. The period runs Sun 1 –
 * Sat 14 Mar 2026; Fran floats in from Mon 2 Mar to Sun 8 Mar, both days included. A shift is
 * judged by the day it starts: Day 12 runs 07:00–19:00, Night 12 19:00–07:00 (Sunday 8 Mar's
 * night ends on Monday 9 Mar, a day outside her dates, and is still Sunday's shift).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, UnitMembership } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { outsideMembership, worksWithinMembershipRule } from './membership.js';
import { defaultRuleSet, evaluateSchedule, resolveConfigs } from './registry.js';

beforeEach(() => resetFixtureCounters());

const fran = () => makeNurse({ id: 'fran', firstName: 'Fran', lastName: 'Okafor' });
const hana = () => makeNurse({ id: 'hana', firstName: 'Hana', lastName: 'Lee' });

const MAR_2_TO_8: UnitMembership = {
  nurseId: 'fran',
  startDate: isoDate('2026-03-02'),
  endDate: isoDate('2026-03-08'),
};

function judge(
  assignments: Assignment[],
  options: { memberships?: UnitMembership[]; priorAssignments?: Assignment[] } = {},
) {
  const s = scenario({
    startDate: isoDate('2026-03-01'),
    endDate: isoDate('2026-03-14'),
    nurses: [fran(), hana()],
    assignments,
    memberships: options.memberships ?? [MAR_2_TO_8],
    ...(options.priorAssignments ? { priorAssignments: options.priorAssignments } : {}),
  });
  return { s, violations: worksWithinMembershipRule.evaluate(s.schedule, {}, s.ctx) };
}

const flaggedIds = (violations: readonly { assignmentIds: readonly string[] }[]) =>
  violations.flatMap((v) => v.assignmentIds);

describe('a float with membership dates on the unit', () => {
  it('flags the Sunday before her first day: Sun 1 Mar is one day before Mon 2 Mar', () => {
    const { violations } = judge([assign('fran', DAY_12, '2026-03-01', { id: 'mar1' })]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'outside_membership',
      severity: 'hard',
      amount: 1,
      nurseIds: ['fran'],
      dates: ['2026-03-01'],
      assignmentIds: ['mar1'],
    });
    expect(violations[0]!.message).toBe(
      'Fran Okafor floats to this unit from Mon Mar 2 to Sun Mar 8; the Day 12 on Sun Mar 1 ' +
        'is outside it.',
    );
  });

  it('flags the Monday after her last day: Mon 9 Mar is one day after Sun 8 Mar', () => {
    const { violations } = judge([assign('fran', DAY_12, '2026-03-09', { id: 'mar9' })]);
    expect(flaggedIds(violations)).toEqual(['mar9']);
  });

  it('lets her work her first and last days, and flags only the days either side', () => {
    // 1 Mar < 2 Mar (out), 2 Mar = start (in), 8 Mar = end (in), 9 Mar > 8 Mar (out).
    const { violations } = judge([
      assign('fran', DAY_12, '2026-03-01', { id: 'mar1' }),
      assign('fran', DAY_12, '2026-03-02', { id: 'mar2' }),
      assign('fran', DAY_12, '2026-03-08', { id: 'mar8' }),
      assign('fran', DAY_12, '2026-03-09', { id: 'mar9' }),
    ]);
    expect(flaggedIds(violations)).toEqual(['mar1', 'mar9']);
  });

  it('judges a night by the day it starts: Sunday 8 Mar’s night into Monday is inside', () => {
    const { violations } = judge([
      assign('fran', NIGHT_12, '2026-03-08', { id: 'sun-night' }),
      assign('fran', NIGHT_12, '2026-03-09', { id: 'mon-night' }),
    ]);
    expect(flaggedIds(violations)).toEqual(['mon-night']);
  });

  it('flags standby outside her dates too: being on call here is working here', () => {
    const { violations } = judge([assign('fran', ON_CALL, '2026-03-10', { id: 'call' })]);
    expect(flaggedIds(violations)).toEqual(['call']);
  });

  it('with no start date, flags only the days after her end date', () => {
    const openStart: UnitMembership = { nurseId: 'fran', endDate: isoDate('2026-03-08') };
    const { violations } = judge(
      [
        assign('fran', DAY_12, '2026-03-01', { id: 'mar1' }),
        assign('fran', DAY_12, '2026-03-08', { id: 'mar8' }),
        assign('fran', DAY_12, '2026-03-09', { id: 'mar9' }),
      ],
      { memberships: [openStart] },
    );
    expect(flaggedIds(violations)).toEqual(['mar9']);
    expect(violations[0]!.message).toBe(
      'Fran Okafor floats to this unit until Sun Mar 8; the Day 12 on Mon Mar 9 is outside it.',
    );
  });

  it('with no end date, flags only the days before her start date', () => {
    const openEnd: UnitMembership = { nurseId: 'fran', startDate: isoDate('2026-03-02') };
    const { violations } = judge(
      [
        assign('fran', DAY_12, '2026-03-01', { id: 'mar1' }),
        assign('fran', DAY_12, '2026-03-14', { id: 'mar14' }),
      ],
      { memberships: [openEnd] },
    );
    expect(flaggedIds(violations)).toEqual(['mar1']);
    expect(violations[0]!.message).toBe(
      'Fran Okafor floats to this unit from Mon Mar 2; the Day 12 on Sun Mar 1 is outside it.',
    );
  });
});

describe('who the rule leaves alone', () => {
  it('never flags last schedule’s shifts, only this one’s', () => {
    // Sat 28 Feb is before her dates, but it is history this schedule cannot change.
    const { violations } = judge([assign('fran', DAY_12, '2026-03-01', { id: 'mar1' })], {
      priorAssignments: [assign('fran', DAY_12, '2026-02-28', { id: 'feb28', periodId: 'prev' })],
    });
    expect(flaggedIds(violations)).toEqual(['mar1']);
  });

  it('never judges a home nurse, who has no membership dates', () => {
    const { violations } = judge([
      assign('hana', DAY_12, '2026-03-01', { id: 'hana1' }),
      assign('hana', DAY_12, '2026-03-12', { id: 'hana12' }),
      assign('fran', DAY_12, '2026-03-12', { id: 'fran12' }),
    ]);
    expect(flaggedIds(violations)).toEqual(['fran12']);
  });

  it('answers the date question the solvers ask: inside, either side, or no membership', () => {
    const { s } = judge([]);
    expect(outsideMembership(s.ctx, 'fran', isoDate('2026-03-01'))).toBe(true);
    expect(outsideMembership(s.ctx, 'fran', isoDate('2026-03-02'))).toBe(false);
    expect(outsideMembership(s.ctx, 'fran', isoDate('2026-03-08'))).toBe(false);
    expect(outsideMembership(s.ctx, 'fran', isoDate('2026-03-09'))).toBe(true);
    expect(outsideMembership(s.ctx, 'hana', isoDate('2026-03-01'))).toBe(false);
  });

  it('refuses two sets of float dates for one nurse rather than guess which binds', () => {
    expect(() =>
      judge([], {
        memberships: [
          MAR_2_TO_8,
          { nurseId: 'fran', startDate: isoDate('2026-03-10'), endDate: isoDate('2026-03-14') },
        ],
      }),
    ).toThrow('Nurse fran has two memberships of this unit');
  });

  it('is on and hard in a new rule set, and silent for a unit with no floats', () => {
    const config = resolveConfigs(defaultRuleSet('unit-1')).find(
      (c) => c.ruleId === 'works-within-membership',
    );
    expect(config?.enabled).toBe(true);
    expect(worksWithinMembershipRule.severity).toBe('hard');
    expect(worksWithinMembershipRule.scope).toBe('nurse');
    const s = scenario({
      startDate: isoDate('2026-03-01'),
      endDate: isoDate('2026-03-14'),
      nurses: [fran()],
      assignments: [assign('fran', DAY_12, '2026-03-01')],
    });
    expect(
      evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
        (v) => v.code === 'outside_membership',
      ),
    ).toEqual([]);
  });
});
