import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import type { ScenarioOptions } from '../testing/fixtures.js';
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
} from '../testing/fixtures.js';
import { type TourRotationParams, tourOf, tourRotationRule } from './tour-rotation.js';

beforeEach(() => {
  resetFixtureCounters();
});

const grace = (overrides = {}) =>
  makeNurse({ id: 'grace', firstName: 'Grace', lastName: 'Campbell', ...overrides });

const DEFAULTS = { maxToursPerPeriod: 2, minHoursBetweenTours: 48, permanentTourEnforced: true };

function evaluate(options: ScenarioOptions, params: Partial<TourRotationParams> = {}) {
  const s = scenario(options);
  return tourRotationRule.evaluate(s.schedule, { ...DEFAULTS, ...params }, s.ctx);
}

describe('which tour a shift belongs to', () => {
  it('classifies a 15:30 tour as evening and an 11:00 mid as day', () => {
    expect(tourOf({ startTime: '15:30' })).toBe('evening');
    expect(tourOf({ startTime: '11:00' })).toBe('day');
  });

  it('puts the boundaries where contracts do: 04:00 is days, 12:00 evenings, 18:00 nights', () => {
    expect(tourOf({ startTime: '04:00' })).toBe('day');
    expect(tourOf({ startTime: '11:59' })).toBe('day');
    expect(tourOf({ startTime: '12:00' })).toBe('evening');
    expect(tourOf({ startTime: '17:59' })).toBe('evening');
    expect(tourOf({ startTime: '18:00' })).toBe('night');
    expect(tourOf({ startTime: '03:59' })).toBe('night');
    expect(tourOf({ startTime: '00:00' })).toBe('night');
  });
});

describe('tour rotation limits', () => {
  it('ships advisory and off until a unit turns it on', () => {
    expect(tourRotationRule).toMatchObject({
      id: 'tour-rotation',
      severity: 'soft',
      scope: 'nurse',
      enabledByDefault: false,
    });
  });

  it('flags nights to days with only 24 hours between', () => {
    const nurse = grace();
    // Night 19:00 Mon 5 Jan ends 07:00 Tue; Day 07:00 Wed 7 Jan starts 24 hours later.
    const night = assign(nurse.id, NIGHT_12, '2026-01-05');
    const day = assign(nurse.id, DAY_12, '2026-01-07');
    const found = evaluate({ nurses: [nurse], assignments: [night, day] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'short_tour_change',
      severity: 'soft',
      nurseIds: ['grace'],
      assignmentIds: [night.id, day.id],
      details: { restHours: 24, requiredHours: 48, fromTour: 'night', toTour: 'day' },
    });
    expect(found[0]!.message).toContain('Grace Campbell');
    expect(found[0]!.message).toContain('24 hours');
    expect(found[0]!.message).toContain('48');
  });

  it('allows nights to days after two full days off', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-08'),
      ],
    });
    expect(found).toEqual([]);
  });

  it('does not ask for a long break between two shifts on the same tour', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, NIGHT_12, '2026-01-06'),
      ],
    });
    expect(found).toEqual([]);
  });

  it('flags a third tour in one schedule', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, EVENING_8, '2026-01-10'),
        assign(nurse.id, NIGHT_12, '2026-01-15'),
      ],
    });
    const tours = found.filter((v) => v.code === 'too_many_tours');
    expect(tours).toHaveLength(1);
    expect(tours[0]!.details).toEqual({ tours: ['day', 'evening', 'night'], max: 2 });
    expect(tours[0]!.assignmentIds).toHaveLength(3);
  });

  it('accepts exactly the most tours allowed', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, DAY_8, '2026-01-07'),
        assign(nurse.id, NIGHT_12, '2026-01-15'),
      ],
    });
    expect(found).toEqual([]);
  });

  it('flags a permanent-nights nurse given a day shift', () => {
    const nurse = grace({ permanentTour: 'night' });
    const day = assign(nurse.id, DAY_12, '2026-01-12');
    const found = evaluate({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-05'), day],
    });
    const off = found.filter((v) => v.code === 'off_permanent_tour');
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({
      assignmentIds: [day.id],
      details: { tour: 'day', permanentTour: 'night' },
    });
    expect(off[0]!.message).toContain('Grace Campbell');
  });

  it('leaves a permanent-tour nurse alone when the contract does not enforce it', () => {
    const nurse = grace({ permanentTour: 'night' });
    const found = evaluate(
      { nurses: [nurse], assignments: [assign(nurse.id, DAY_12, '2026-01-12')] },
      { permanentTourEnforced: false },
    );
    expect(found).toEqual([]);
  });

  it('does not count on-call standby as a tour', () => {
    const nurse = grace({ permanentTour: 'day' });
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, ON_CALL, '2026-01-06'),
      ],
    });
    expect(found).toEqual([]);
  });

  it('flags a quick change back from last schedule, but not history against history', () => {
    const nurse = grace();
    // Night Sat 3 Jan ends 07:00 Sun 4 Jan; Day 07:00 Mon 5 Jan is 24 hours on.
    const lastNight = assign(nurse.id, NIGHT_12, '2026-01-03', { periodId: 'prev' });
    const day = assign(nurse.id, DAY_12, '2026-01-05');
    expect(
      evaluate({ nurses: [nurse], priorAssignments: [lastNight], assignments: [day] }),
    ).toHaveLength(1);

    // Evening then night, both before the period: nothing this schedule can fix.
    const oldDay = assign(nurse.id, DAY_12, '2026-01-01', { periodId: 'prev' });
    const oldNight = assign(nurse.id, NIGHT_12, '2026-01-02', { periodId: 'prev' });
    expect(evaluate({ nurses: [nurse], priorAssignments: [oldDay, oldNight] })).toEqual([]);
  });

  it('counts tours over this schedule only, not last one', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      priorAssignments: [assign(nurse.id, EVENING_8, '2025-12-20', { periodId: 'prev' })],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, NIGHT_12, '2026-01-15'),
      ],
    });
    expect(found).toEqual([]);
  });
});

describe('career nurses exempt from rotation (UC–CNA Art. 14 § P.1.a)', () => {
  // The schedule starts Sun 4 Jan 2026: seniority from 1 Jan 2015 is 11 years, from 1 Jan 2017 nine.
  const ELEVEN_YEARS = { seniorityDate: isoDate('2015-01-01') };
  const NINE_YEARS = { seniorityDate: isoDate('2017-01-01') };
  const EXEMPT_AT_TEN = { maxToursPerPeriod: 2, exemptAfterYearsOfService: 10 };

  it('flags an eleven-year nurse rotated from nights to days, though two tours are allowed', () => {
    const nurse = grace(ELEVEN_YEARS);
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-15'),
        ],
      },
      EXEMPT_AT_TEN,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'too_many_tours',
      severity: 'soft',
      details: { tours: ['day', 'night'], max: 1 },
    });
    expect(found[0]!.message).toContain('exempt from rotation after 10 years of service');
  });

  it('still rotates a nine-year nurse across two tours', () => {
    const nurse = grace(NINE_YEARS);
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-15'),
        ],
      },
      EXEMPT_AT_TEN,
    );
    expect(found).toEqual([]);
  });

  it('counts service from the hire date when it differs from seniority', () => {
    // Seniority bridged back to 2010, but hired 1 Jan 2017: nine years on the job.
    const nurse = grace({ seniorityDate: isoDate('2010-01-01'), hireDate: isoDate('2017-01-01') });
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-15'),
        ],
      },
      EXEMPT_AT_TEN,
    );
    expect(found).toEqual([]);
  });

  it('keeps an eleven-year nurse on permanent nights even when permanent tours are not enforced', () => {
    const nurse = grace({ ...ELEVEN_YEARS, permanentTour: 'night' });
    const day = assign(nurse.id, DAY_12, '2026-01-12');
    const found = evaluate(
      { nurses: [nurse], assignments: [day] },
      { ...EXEMPT_AT_TEN, permanentTourEnforced: false },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'off_permanent_tour',
      assignmentIds: [day.id],
      details: { tour: 'day', permanentTour: 'night' },
    });
    expect(found[0]!.message).toContain('exempt from rotation after 10 years of service');
  });

  it('exempts a nurse from the day of their tenth anniversary', () => {
    // Seniority Mon 4 Jan 2016; the schedule starts Sun 4 Jan 2026: ten years to the day.
    const nurse = grace({ seniorityDate: isoDate('2016-01-04') });
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-15'),
        ],
      },
      EXEMPT_AT_TEN,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'too_many_tours', details: { max: 1 } });
  });

  it('still rotates a nurse whose tenth anniversary falls the day after the schedule starts', () => {
    // Seniority Tue 5 Jan 2016: on Sun 4 Jan 2026 that is nine years and 364 days.
    const nurse = grace({ seniorityDate: isoDate('2016-01-05') });
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, NIGHT_12, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-15'),
        ],
      },
      EXEMPT_AT_TEN,
    );
    expect(found).toEqual([]);
  });

  it('exempts nobody when the contract sets no years of service', () => {
    const nurse = grace({ seniorityDate: isoDate('1995-01-01') });
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-15'),
      ],
    });
    expect(found).toEqual([]);
  });
});
