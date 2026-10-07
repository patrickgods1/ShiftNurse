import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, ShiftType } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import type { ScenarioOptions } from '../testing/fixtures.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { daysOffTogetherRule } from './days-off-together.js';
import { defaultRuleSet } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

// The fixture unit's 14-day pay periods are anchored on Sun 4 Jan 2026, and the default schedule
// period is exactly Sun 4 – Sat 17 Jan: one pay period, weekends keyed Sat 3, Sat 10, Sat 17.
const ana = () => makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz' });

const days = (dates: string[], shiftType: ShiftType = DAY_12): Assignment[] =>
  dates.map((date) => assign('ana', shiftType, date));

/** Every weekend of the pay period: Sun 4 (Sat 3's weekend), Sat 10, Sun 11, Sat 17. */
const EVERY_WEEKEND = ['2026-01-04', '2026-01-10', '2026-01-11', '2026-01-17'];

function evaluate(assignments: Assignment[], options: ScenarioOptions = {}) {
  const s = scenario({ nurses: [ana()], assignments, ...options });
  return daysOffTogetherRule.evaluate(s.schedule, {}, s.ctx);
}

describe('two days off together for a nurse who works every weekend', () => {
  it('ships advisory and off until a unit turns it on', () => {
    expect(daysOffTogetherRule).toMatchObject({
      id: 'days-off-together',
      severity: 'soft',
      category: 'equity',
      scope: 'nurse',
      enabledByDefault: false,
    });
    const config = defaultRuleSet('unit-1').configs.find((c) => c.ruleId === 'days-off-together');
    expect(config?.enabled).toBe(false);
  });

  it('flags every weekend worked with the days off scattered one at a time', () => {
    // Off 6, 8, 12, 14 and 16 Jan: no two of them adjacent. Ids named by date, given out of order.
    const shifts = [
      '2026-01-04',
      '2026-01-10',
      '2026-01-11',
      '2026-01-17',
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-15',
    ].map((date) => assign('ana', DAY_12, date, { id: `d${date.slice(8)}` }));
    const found = evaluate(shifts);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'no_days_off_together',
      severity: 'soft',
      nurseIds: ['ana'],
      dates: [
        '2026-01-04',
        '2026-01-05',
        '2026-01-07',
        '2026-01-09',
        '2026-01-10',
        '2026-01-11',
        '2026-01-13',
        '2026-01-15',
        '2026-01-17',
      ],
      assignmentIds: ['d04', 'd05', 'd07', 'd09', 'd10', 'd11', 'd13', 'd15', 'd17'],
      details: { payPeriodStart: '2026-01-04', payPeriodEnd: '2026-01-17', weekends: 3 },
    });
    expect(found[0]!.message).toBe(
      'Ana Cruz works every weekend of the pay period Sun Jan 4 – Sat Jan 17, 2026 and has ' +
        'no two days off together in it.',
    );
  });

  it('accepts every weekend worked when Thursday and Friday are off together', () => {
    // Off 8, 12, 15 and 16 Jan: Thu 15 and Fri 16 are a pair.
    const shifts = days([
      ...EVERY_WEEKEND,
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-14',
    ]);
    expect(evaluate(shifts)).toEqual([]);
  });

  it('asks nothing of a nurse who has the middle weekend off, however the weekdays fall', () => {
    // Every weekday worked; only Sat 10 and Sun 11 are off.
    const shifts = days([
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-12',
      '2026-01-13',
      '2026-01-14',
      '2026-01-15',
      '2026-01-16',
      '2026-01-17',
    ]);
    expect(evaluate(shifts)).toEqual([]);
  });

  it('does not count a Friday night as the Saturday’s weekend, but does count the Saturday', () => {
    // The scattered pattern with the night of Fri 16 in place of the day on Sat 17. Under the
    // default weekend (shifts starting Sat 00:00 – Mon 00:00) the 19:00 Friday start is not a
    // weekend shift, so the weekend of the 17th is not worked: nothing is owed.
    const weekdays = ['2026-01-05', '2026-01-07', '2026-01-09', '2026-01-13', '2026-01-15'];
    const fridayNight = assign('ana', NIGHT_12, '2026-01-16');
    const withoutSaturday = [
      ...days(['2026-01-04', '2026-01-10', '2026-01-11', ...weekdays]),
      fridayNight,
    ];
    expect(evaluate(withoutSaturday)).toEqual([]);
    // Work the Saturday too and every weekend is worked; off 6, 8, 12, 14 — none together.
    const found = evaluate([...withoutSaturday, assign('ana', DAY_12, '2026-01-17')]);
    expect(found.map((v) => v.code)).toEqual(['no_days_off_together']);
  });

  it('counts the Saturday a Friday night ends on as a day off: shifts are dated by their start', () => {
    // Weekends that take in a Friday night: the night of Fri 9 runs into Sat 10, so it works the
    // weekend of the 10th. Off 6, 8, 10, 11, 14, 16: Sat 10 (where the night ends at 07:00) and
    // Sun 11 are the only pair, and they count.
    const overlaps = { ...DEFAULT_WEEKEND, mode: 'overlaps' as const };
    const shifts = [
      ...days(['2026-01-04', '2026-01-05', '2026-01-07']),
      assign('ana', NIGHT_12, '2026-01-09'),
      ...days(['2026-01-12', '2026-01-13', '2026-01-15', '2026-01-17']),
    ];
    const s = scenario({ nurses: [ana()], assignments: shifts });
    const ctx = { ...s.ctx, weekendDefinition: overlaps };
    expect(daysOffTogetherRule.evaluate(s.schedule, {}, ctx)).toEqual([]);
    // Work Sun 11 as well and Sat 10 has no partner: the same pattern is now a breach.
    const tighter = scenario({
      nurses: [ana()],
      assignments: [...shifts, assign('ana', DAY_12, '2026-01-11')],
    });
    const found = daysOffTogetherRule.evaluate(
      tighter.schedule,
      {},
      {
        ...tighter.ctx,
        weekendDefinition: overlaps,
      },
    );
    expect(found.map((v) => v.code)).toEqual(['no_days_off_together']);
  });

  it('does not count on-call standby on a Saturday as a weekend worked', () => {
    // Off 6, 8, 12, 14; Sat 17 is standby only. Worked, the Saturday would make it a breach.
    const rest = days([
      '2026-01-04',
      '2026-01-10',
      '2026-01-11',
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-15',
      '2026-01-16',
    ]);
    expect(evaluate([...rest, assign('ana', ON_CALL, '2026-01-17')])).toEqual([]);
    expect(evaluate([...rest, assign('ana', DAY_12, '2026-01-17')])).toHaveLength(1);
  });

  it('counts last schedule’s Saturday toward the first weekend of the pay period', () => {
    // Sat 3 Jan was worked last schedule, so the weekend of the 3rd is worked with Sun 4 off.
    // Off 4, 6, 8, 12, 14, 16: none together.
    const shifts = days([
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-10',
      '2026-01-11',
      '2026-01-13',
      '2026-01-15',
      '2026-01-17',
    ]);
    const prior = [assign('ana', DAY_12, '2026-01-03', { periodId: 'prev' })];
    const found = evaluate(shifts, { priorAssignments: prior });
    expect(found).toHaveLength(1);
    expect(found[0]!.dates).not.toContain('2026-01-03');
    expect(found[0]!.details).toMatchObject({ weekends: 3 });
  });

  it('judges only the pay period the schedule wholly covers', () => {
    // Sun 4 – Sat 24 Jan: the pay period of 4–17 Jan is whole, the one from Sun 18 is cut off at
    // the 24th. Both are worked every weekend with no two days off together.
    const shifts = days([
      ...EVERY_WEEKEND,
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-15',
      '2026-01-18',
      '2026-01-19',
      '2026-01-21',
      '2026-01-23',
      '2026-01-24',
    ]);
    const found = evaluate(shifts, { endDate: isoDate('2026-01-24') });
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toMatchObject({ payPeriodStart: '2026-01-04' });
    expect(found[0]!.dates).not.toContain('2026-01-18');
  });

  it('judges nothing when the schedule only partly covers the pay period', () => {
    const shifts = days(['2026-01-10', '2026-01-11', '2026-01-13', '2026-01-15', '2026-01-17']);
    expect(evaluate(shifts, { startDate: isoDate('2026-01-10') })).toEqual([]);
  });
});
