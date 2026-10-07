/**
 * Weekends by hand, under the default definition (Saturday 00:00 to Monday 00:00, by shift
 * start). The fixture period runs Sun 4 – Sat 17 Jan 2026, so it touches three weekends, keyed by
 * their Saturdays: 3 Jan (the period's first day is its Sunday), 10 Jan and 17 Jan.
 */

import { beforeEach, describe, expect, it } from 'vitest';
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
import { defaultRuleSet, resolveConfigs } from './registry.js';
import { type WeekendPatternParams, weekendPatternRule } from './weekend-pattern.js';

beforeEach(() => resetFixtureCounters());

const EVERY_OTHER: WeekendPatternParams = { maxConsecutiveWeekends: 1 };

function judge(
  dates: string[],
  params: WeekendPatternParams = EVERY_OTHER,
  extra: Parameters<typeof scenario>[0] = {},
) {
  const nurse = makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz' });
  const s = scenario({
    nurses: [nurse],
    assignments: dates.map((d) => assign('ana', DAY_12, d)),
    ...extra,
  });
  return weekendPatternRule.evaluate(s.schedule, params, s.ctx);
}

describe('every other weekend', () => {
  it('flags the second of two weekends in a row', () => {
    const violations = judge(['2026-01-04', '2026-01-10']);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'excess_weekends',
      severity: 'soft',
      nurseIds: ['ana'],
      dates: ['2026-01-10'],
    });
    expect(violations[0]!.message).toContain('Ana Cruz');
    expect(violations[0]!.message).toContain('2 weekends in a row');
  });

  it('lets a nurse work the first and third weekends', () => {
    expect(judge(['2026-01-04', '2026-01-17'])).toEqual([]);
  });

  it('counts Saturday and Sunday of one weekend once', () => {
    expect(judge(['2026-01-10', '2026-01-11'])).toEqual([]);
  });

  it('carries a weekend in from the period before', () => {
    const violations = judge(['2026-01-04'], EVERY_OTHER, {
      priorAssignments: [assign('ana', DAY_12, '2025-12-27')],
    });
    expect(violations.map((v) => v.dates)).toEqual([['2026-01-04']]);
  });

  it('says nothing about a run that lies wholly in the period before', () => {
    expect(
      judge(['2026-01-07'], EVERY_OTHER, {
        priorAssignments: [
          assign('ana', DAY_12, '2025-12-20'),
          assign('ana', DAY_12, '2025-12-27'),
        ],
      }),
    ).toEqual([]);
  });

  it('allows two in a row and flags the third when the contract allows two', () => {
    const violations = judge(['2026-01-04', '2026-01-10', '2026-01-17'], {
      maxConsecutiveWeekends: 2,
    });
    expect(violations.map((v) => v.dates)).toEqual([['2026-01-17']]);
    expect(violations[0]!.message).toContain('3 weekends in a row');
  });

  it('does not count on-call standby as a weekend worked', () => {
    const nurse = makeNurse({ id: 'ana' });
    const s = scenario({
      nurses: [nurse],
      assignments: [assign('ana', DAY_12, '2026-01-04'), assign('ana', ON_CALL, '2026-01-10')],
    });
    expect(weekendPatternRule.evaluate(s.schedule, EVERY_OTHER, s.ctx)).toEqual([]);
  });

  it('counts a Sunday night as that weekend, though it ends on Monday', () => {
    const nurse = makeNurse({ id: 'ana' });
    const s = scenario({
      nurses: [nurse],
      assignments: [assign('ana', DAY_12, '2026-01-10'), assign('ana', NIGHT_12, '2026-01-04')],
    });
    // Sun 4 Jan night is the 3 Jan weekend; Sat 10 Jan is the next one.
    expect(weekendPatternRule.evaluate(s.schedule, EVERY_OTHER, s.ctx)).toHaveLength(1);
  });
});

describe('weekends per schedule', () => {
  it('flags weekends past the limit, however they are spread', () => {
    const violations = judge(['2026-01-04', '2026-01-17'], {
      maxConsecutiveWeekends: 3,
      maxWeekendsPerPeriod: 1,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ code: 'excess_weekends', details: { excess: 1 } });
    expect(violations[0]!.message).toContain('2 weekends in this schedule, 1 more than');
  });

  it('starts switched off, in a new rule set and in one saved before it shipped', () => {
    const fresh = defaultRuleSet('unit-1');
    const configOf = (configs: { ruleId: string; enabled: boolean }[]) =>
      configs.find((c) => c.ruleId === weekendPatternRule.id);
    expect(configOf(fresh.configs)?.enabled).toBe(false);
    const older = {
      ...fresh,
      configs: fresh.configs.filter((c) => c.ruleId !== weekendPatternRule.id),
    };
    expect(configOf(resolveConfigs(older))?.enabled).toBe(false);
  });
});

describe('weekends in any four weeks', () => {
  // Runs out of the way (three in a row allowed), so only the four-week window speaks.
  const TWO_IN_FOUR: WeekendPatternParams = { maxConsecutiveWeekends: 3, maxWeekendsPer4Weeks: 2 };

  it('lets a nurse work alternate weekends on a four-week schedule that starts on a Sunday', () => {
    // Weekends 3, 17 and 31 Jan: two of every four, though the schedule touches five weekends.
    expect(
      judge(['2026-01-04', '2026-01-17', '2026-01-31'], TWO_IN_FOUR, {
        startDate: isoDate('2026-01-04'),
        endDate: isoDate('2026-01-31'),
      }),
    ).toEqual([]);
  });

  it('flags the third weekend in four on a six-week schedule', () => {
    const violations = judge(['2026-01-10', '2026-01-17', '2026-01-24'], TWO_IN_FOUR, {
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-02-15'),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'excess_weekends',
      nurseIds: ['ana'],
      dates: ['2026-01-10', '2026-01-17', '2026-01-24'],
      details: { weekend: '2026-01-24', workedIn4Weeks: 3, excess: 1 },
    });
    expect(violations[0]!.message).toContain('3 of the 4 weekends');
    expect(violations[0]!.message).toContain('Ana Cruz');
  });

  it('counts a weekend worked in the schedule before', () => {
    // Window to 17 Jan: 27 Dec (last schedule), 3 Jan (off), 10 and 17 Jan.
    const violations = judge(['2026-01-10', '2026-01-17'], TWO_IN_FOUR, {
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-31'),
      priorAssignments: [assign('ana', DAY_12, '2025-12-27')],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      dates: ['2026-01-10', '2026-01-17'],
      details: { weekend: '2026-01-17', workedIn4Weeks: 3, excess: 1 },
    });
  });

  it('weighs a fourth weekend in four heavier than a third', () => {
    const violations = judge(
      ['2026-01-10', '2026-01-17', '2026-01-24', '2026-01-31'],
      {
        maxConsecutiveWeekends: 4,
        maxWeekendsPer4Weeks: 2,
      },
      { startDate: isoDate('2026-01-04'), endDate: isoDate('2026-01-31') },
    );
    expect(violations.map((v) => v.details)).toEqual([
      { weekend: '2026-01-24', workedIn4Weeks: 3, excess: 1 },
      { weekend: '2026-01-31', workedIn4Weeks: 4, excess: 2 },
    ]);
  });
});
