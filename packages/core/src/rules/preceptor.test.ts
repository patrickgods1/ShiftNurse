import { beforeEach, describe, expect, it } from 'vitest';
import type { Preceptorship } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  MID_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  scenario,
  UNIT_ID,
} from '../testing/fixtures.js';
import { preceptorRule } from './preceptor.js';
import { defaultRuleSet, resolveConfigs } from './registry.js';

beforeEach(() => resetFixtureCounters());

const new_ = () => makeNurse({ id: 'new', firstName: 'Noa', lastName: 'Kim', isNovice: true });
const pat = () => makeNurse({ id: 'pat', firstName: 'Pat', lastName: 'Ruiz' });
const sam = () => makeNurse({ id: 'sam', firstName: 'Sam', lastName: 'Lee' });

function preceptorship(
  preceptorId: string,
  startDate = '2026-01-04',
  endDate = '2026-01-17',
): Preceptorship {
  return {
    id: `p-${preceptorId}`,
    unitId: UNIT_ID,
    orienteeId: 'new',
    preceptorId,
    startDate: isoDate(startDate),
    endDate: isoDate(endDate),
  };
}

function judge(options: Parameters<typeof scenario>[0]) {
  const s = scenario({ shiftTypes: [DAY_12, NIGHT_12, MID_8], ...options });
  return preceptorRule.evaluate(s.schedule, preceptorRule.defaultParams, s.ctx);
}

describe('an orientee works with their preceptor', () => {
  it('flags an orientee on a shift their preceptor is not on', () => {
    const violations = judge({
      nurses: [new_(), pat(), sam()],
      assignments: [
        assign('new', DAY_12, '2026-01-06', { id: 'a-new' }),
        assign('sam', DAY_12, '2026-01-06'),
        assign('pat', NIGHT_12, '2026-01-06'),
      ],
      preceptorships: [preceptorship('pat')],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'orientee_without_preceptor',
      severity: 'hard',
      nurseIds: ['new'],
      assignmentIds: ['a-new'],
      dates: ['2026-01-06'],
    });
    expect(violations[0]!.message).toBe(
      'Noa Kim is in orientation with Pat Ruiz, who is not on the Day 12 on Tue Jan 6.',
    );
  });

  it('is satisfied when the preceptor works the same shift', () => {
    expect(
      judge({
        nurses: [new_(), pat()],
        assignments: [assign('new', DAY_12, '2026-01-06'), assign('pat', DAY_12, '2026-01-06')],
        preceptorships: [preceptorship('pat')],
      }),
    ).toEqual([]);
  });

  it('counts a preceptor on the day 12 for an orientee on the mid 8 inside it', () => {
    expect(
      judge({
        nurses: [new_(), pat()],
        assignments: [assign('new', MID_8, '2026-01-06'), assign('pat', DAY_12, '2026-01-06')],
        preceptorships: [preceptorship('pat')],
      }),
    ).toEqual([]);
  });

  it('does not count a preceptor on the mid 8 for an orientee on the whole day 12', () => {
    expect(
      judge({
        nurses: [new_(), pat()],
        assignments: [assign('new', DAY_12, '2026-01-06'), assign('pat', MID_8, '2026-01-06')],
        preceptorships: [preceptorship('pat')],
      }),
    ).toHaveLength(1);
  });

  it('accepts any one of two preceptors', () => {
    expect(
      judge({
        nurses: [new_(), pat(), sam()],
        assignments: [assign('new', DAY_12, '2026-01-06'), assign('sam', DAY_12, '2026-01-06')],
        preceptorships: [preceptorship('pat'), preceptorship('sam')],
      }),
    ).toEqual([]);
  });

  it('lets the orientee work alone once the orientation has ended', () => {
    expect(
      judge({
        nurses: [new_(), pat()],
        assignments: [assign('new', DAY_12, '2026-01-12')],
        preceptorships: [preceptorship('pat', '2026-01-04', '2026-01-11')],
      }),
    ).toEqual([]);
  });

  it('names both preceptors when neither is on', () => {
    const violations = judge({
      nurses: [new_(), pat(), sam()],
      assignments: [assign('new', DAY_12, '2026-01-06')],
      preceptorships: [preceptorship('pat'), preceptorship('sam')],
    });
    expect(violations[0]!.message).toContain('with Pat Ruiz or Sam Lee, neither of whom is on');
  });

  it('is on in every rule set, and silent until someone is in orientation', () => {
    const fresh = defaultRuleSet('unit-1');
    expect(resolveConfigs(fresh).find((c) => c.ruleId === preceptorRule.id)?.enabled).toBe(true);
    expect(judge({ nurses: [new_()], assignments: [assign('new', DAY_12, '2026-01-06')] })).toEqual(
      [],
    );
  });
});
