import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { assign, DAY_12, makeNurse, resetFixtureCounters, scenario } from '../testing/fixtures.js';

beforeEach(() => resetFixtureCounters());

const DATE = isoDate('2026-01-07');

describe('a nurse floated off to another unit', () => {
  it('does not count a nurse floated off the shift among those on it', () => {
    const stays = makeNurse({ id: 'stays', role: 'RN' });
    const floated = makeNurse({ id: 'floated', role: 'RN' });
    const { schedule } = scenario({
      startDate: DATE,
      endDate: DATE,
      nurses: [stays, floated],
      assignments: [
        assign('stays', DAY_12, DATE),
        assign('floated', DAY_12, DATE, { floatedTo: '5 East' }),
      ],
    });
    // Two on the day 12, one sent to 5 East: one on this floor.
    expect(schedule.onShift(DATE, DAY_12.id)).toHaveLength(1);
    expect(schedule.countOnShift(DATE, DAY_12.id, 'RN')).toBe(1);
    expect(schedule.rosterAt(DATE, DAY_12.id)).toHaveLength(1);
    // She still worked it: her own record keeps the one shift.
    expect(schedule.timelineFor('floated')).toHaveLength(1);
    expect(schedule.assignmentsFor('floated')).toHaveLength(1);
  });
});
