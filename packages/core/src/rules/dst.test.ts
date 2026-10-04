/**
 * The schedule lives on a wall-clock timeline where every day is 1440 minutes, so the spring-
 * forward and fall-back Sundays must not move a rest gap or a work week by an hour. Expected
 * values are worked by hand: 2026-03-07 is a Saturday, the clocks jump on Sunday 2026-03-08.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { evaluateSchedule } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

const SPRING = { startDate: isoDate('2026-03-01'), endDate: isoDate('2026-03-14') };

function restViolations(s: ReturnType<typeof scenario>) {
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
    (v) => v.code === 'insufficient_rest',
  );
}

function withMinRest(hours: number) {
  return { 'min-rest-between-shifts': { minRestHours: hours } };
}

describe('rest across the spring-forward weekend', () => {
  it('gives a full day off between the Saturday night and Monday morning', () => {
    const nurse = makeNurse();
    for (const hours of [10, 12]) {
      const s = scenario({
        ...SPRING,
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-03-07'), // ends Sunday 07:00
          assign(nurse.id, DAY_12, '2026-03-09'), // Monday 07:00: 24h later
        ],
        ruleParams: withMinRest(hours),
      });
      expect(restViolations(s)).toEqual([]);
    }
  });

  it('counts twelve hours of rest before Sunday night, whatever the clocks did', () => {
    const nurse = makeNurse();
    const build = (hours: number) =>
      scenario({
        ...SPRING,
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-03-07'), // ends Sunday 07:00
          assign(nurse.id, NIGHT_12, '2026-03-08'), // starts Sunday 19:00
        ],
        ruleParams: withMinRest(hours),
      });
    expect(restViolations(build(12))).toEqual([]);
    const flagged = restViolations(build(13));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.details?.restHours).toBe(12);
  });

  it('keeps a lookback night from the prior period in the rest maths', () => {
    const nurse = makeNurse();
    const night = assign(nurse.id, NIGHT_12, '2026-03-07', { id: 'prior-night' });
    const day = assign(nurse.id, DAY_12, '2026-03-08', { id: 'in-period-day' });
    const s = scenario({
      startDate: isoDate('2026-03-08'),
      endDate: isoDate('2026-03-21'),
      nurses: [nurse],
      priorAssignments: [night],
      assignments: [day],
    });
    const rest = restViolations(s);
    expect(rest).toHaveLength(1);
    expect(rest[0]?.details?.restHours).toBe(0);
    expect(rest[0]?.assignmentIds).toContain('in-period-day');
    // One finding for the pair, not a second one against the lookback night itself.
    expect(rest[0]?.dates).toEqual([isoDate('2026-03-07'), isoDate('2026-03-08')]);
  });
});

describe('rest across the fall-back weekend', () => {
  it('still counts twelve hours between the Saturday night and Sunday night', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-10-31'), // ends Sunday 11-01 07:00
        assign(nurse.id, NIGHT_12, '2026-11-01'),
      ],
      ruleParams: withMinRest(12),
    });
    expect(restViolations(s)).toEqual([]);
  });
});
