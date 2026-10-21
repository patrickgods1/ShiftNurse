import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import { busyElsewhere } from '../schedule/elsewhere.js';
import type { ScenarioOptions } from '../testing/fixtures.js';
import {
  assign,
  DAY_8,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
} from '../testing/fixtures.js';
import { completeWeekendsRule } from './complete-weekends.js';
import { defaultRuleSet } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

// The default schedule period is Sun 4 – Sat 17 Jan 2026. Under the default weekend (Sat 00:00
// for 48 hours) its weekends are Sat 3 – Sun 4, Sat 10 – Sun 11 and Sat 17 – Sun 18.
const ana = (extra: Partial<Nurse> = {}) =>
  makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz', ...extra });

function evaluate(assignments: Assignment[], options: ScenarioOptions = {}) {
  const s = scenario({ nurses: [ana()], assignments, ...options });
  return completeWeekendsRule.evaluate(s.schedule, {}, s.ctx);
}

describe('complete weekends', () => {
  it('ships advisory and off until a unit turns it on', () => {
    expect(completeWeekendsRule).toMatchObject({
      id: 'complete-weekends',
      severity: 'soft',
      category: 'equity',
      scope: 'nurse',
      enabledByDefault: false,
    });
    const config = defaultRuleSet('unit-1').configs.find((c) => c.ruleId === 'complete-weekends');
    expect(config?.enabled).toBe(false);
  });

  it('flags a nurse given only the Saturday: the whole weekend is lost for one shift', () => {
    // Sat 10 worked, Sun 11 not: one of the weekend's two days unworked.
    const found = evaluate([assign('ana', DAY_12, '2026-01-10', { id: 'sat' })]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'split_weekend',
      severity: 'soft',
      amount: 1,
      nurseIds: ['ana'],
      dates: ['2026-01-10'],
      assignmentIds: ['sat'],
      details: {
        weekend: '2026-01-10',
        weekendDates: ['2026-01-10', '2026-01-11'],
        unworkedDates: ['2026-01-11'],
      },
    });
    expect(found[0]!.message).toBe(
      'Ana Cruz works the weekend of Sat Jan 10 – Sun Jan 11, 2026 only in part: no shift starts ' +
        'on Sun Jan 11, so 1 of its 2 days is worked. A weekend worked should be worked whole.',
    );
  });

  it('accepts the Saturday and the Sunday worked together', () => {
    expect(
      evaluate([assign('ana', DAY_12, '2026-01-10'), assign('ana', NIGHT_12, '2026-01-11')]),
    ).toEqual([]);
  });

  it('counts a Friday night that runs into the weekend as working it, but not as working either day', () => {
    // Under 'overlaps' the night of Fri 9 (19:00 – Sat 07:00) is filed under the weekend of the
    // 10th. It is dated Friday, by its start, so neither Sat 10 nor Sun 11 has a shift: 2 days
    // unworked of 2.
    const overlaps = { ...DEFAULT_WEEKEND, mode: 'overlaps' as const };
    const s = scenario({
      nurses: [ana()],
      assignments: [assign('ana', NIGHT_12, '2026-01-09', { id: 'fri' })],
    });
    const found = completeWeekendsRule.evaluate(
      s.schedule,
      {},
      {
        ...s.ctx,
        weekendDefinition: overlaps,
      },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      amount: 2,
      dates: ['2026-01-09'],
      assignmentIds: ['fri'],
      details: { weekend: '2026-01-10', unworkedDates: ['2026-01-10', '2026-01-11'] },
    });
  });

  it('leaves a weekend running past the last day of the schedule to the next one', () => {
    // Sat 17 is the period's last day; Sun 18 belongs to the next schedule, which decides.
    expect(evaluate([assign('ana', DAY_12, '2026-01-17')])).toEqual([]);
  });

  it('reads the Saturday before the schedule from the published tail', () => {
    // Sun 4 worked; Sat 3 is in the lookback. Worked there, the weekend is whole.
    const sunday = assign('ana', DAY_12, '2026-01-04', { id: 'sun' });
    const saturday = assign('ana', DAY_12, '2026-01-03', { periodId: 'prior' });
    expect(evaluate([sunday], { priorAssignments: [saturday] })).toEqual([]);
    // Not worked there: Sat 3 is the one day unworked, and only the in-period Sunday is named.
    const found = evaluate([sunday]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      amount: 1,
      assignmentIds: ['sun'],
      details: { weekend: '2026-01-03', unworkedDates: ['2026-01-03'] },
    });
  });

  it('leaves a weekend alone when its Saturday is before the complete history', () => {
    // Sun 4 worked, Sat 3 before the period. History complete only from Sun 4: nobody knows
    // whether she worked Sat 3, so the weekend is not judged.
    const sunday = [assign('ana', DAY_12, '2026-01-04')];
    expect(evaluate(sunday, { historyFrom: isoDate('2026-01-04') })).toEqual([]);
    // Complete from Sat 3 (or earlier) with no Saturday shift in the tail: Sat 3 was off, one day
    // of two unworked.
    for (const from of ['2026-01-03', '2025-12-20']) {
      const found = evaluate(sunday, { historyFrom: isoDate(from) });
      expect(
        found.map((v) => [v.amount, v.details?.unworkedDates]),
        from,
      ).toEqual([[1, ['2026-01-03']]]);
    }
  });

  it('does not judge a weekend worked only in the published tail', () => {
    // Sat 3 worked last schedule, Sun 4 off: history, which this schedule cannot fix.
    const saturday = assign('ana', DAY_12, '2026-01-03', { periodId: 'prior' });
    expect(evaluate([], { priorAssignments: [saturday] })).toEqual([]);
  });

  it('does not judge a Baylor nurse, whose weekends are the plan', () => {
    const s = scenario({
      nurses: [ana({ scheduleKind: 'va_baylor' })],
      assignments: [assign('ana', DAY_12, '2026-01-10')],
    });
    expect(completeWeekendsRule.evaluate(s.schedule, {}, s.ctx)).toEqual([]);
  });

  it('does not count on-call standby on a Saturday as working the weekend', () => {
    expect(evaluate([assign('ana', ON_CALL, '2026-01-10')])).toEqual([]);
    // Nor as working the Saturday: a day shift on Sun 11 beside it is still half a weekend.
    const found = evaluate([
      assign('ana', ON_CALL, '2026-01-10'),
      assign('ana', DAY_12, '2026-01-11'),
    ]);
    expect(found.map((v) => [v.amount, v.details?.unworkedDates])).toEqual([[1, ['2026-01-10']]]);
  });

  it('judges this unit’s weekend by this unit’s shifts: a Sunday on 5 West does not complete it', () => {
    const WEST = { ...DAY_8, id: 'west-d8', unitId: 'unit-west' };
    const west = busyElsewhere(
      [assign('ana', WEST, '2026-01-11', { periodId: 'west' })],
      [WEST],
      '5 West',
    );
    const found = evaluate([assign('ana', DAY_12, '2026-01-10')], {
      shiftTypes: [...testShiftTypes, ...west.shiftTypes],
      priorAssignments: west.assignments,
    });
    expect(found.map((v) => v.amount)).toEqual([1]);
    // A Saturday on 5 West alone is not a weekend worked here.
    const elsewhereOnly = busyElsewhere(
      [assign('ana', WEST, '2026-01-10', { periodId: 'west' })],
      [WEST],
      '5 West',
    );
    expect(
      evaluate([], {
        shiftTypes: [...testShiftTypes, ...elsewhereOnly.shiftTypes],
        priorAssignments: elsewhereOnly.assignments,
      }),
    ).toEqual([]);
  });
});
