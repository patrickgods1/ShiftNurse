import { beforeEach, describe, expect, it } from 'vitest';

import { addDays, DEFAULT_WEEKEND, isoDate, type WeekendDefinition } from '../domain/time.js';
import {
  assign,
  assignRun,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testUnit,
} from '../testing/fixtures.js';
import { deriveCounters, isUndesirable, preferenceSatisfaction } from './ledger.js';
import type { CounterContext } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** A bare context with no holidays/preferences/time-off, for tests that only need one signal. */
function baseCtx(overrides: Partial<CounterContext> = {}): CounterContext {
  return {
    unit: testUnit,
    holidayDates: new Set(),
    weekendDefinition: DEFAULT_WEEKEND,
    preferences: [],
    ...overrides,
  };
}

describe('weekends worked', () => {
  it('counts a Saturday and Sunday shift as one weekend', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-10'), assign(nurse.id, DAY_12, '2026-01-11')],
    });
    const counters = deriveCounters(s.schedule, baseCtx());
    expect(counters.get(nurse.id)?.weekendsWorked).toBe(1);
  });

  it('counts the Friday night as a weekend shift under an overlaps definition', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      // 19:00 Fri -> 07:00 Sat: no part of it is "within" the weekend window, but it overlaps one.
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-09')],
    });
    const overlaps: WeekendDefinition = {
      startWeekday: 6,
      startMinute: 0,
      durationMinutes: 2 * 1440,
      mode: 'overlaps',
    };

    const underOverlaps = deriveCounters(s.schedule, baseCtx({ weekendDefinition: overlaps }));
    expect(underOverlaps.get(nurse.id)?.weekendsWorked).toBe(1);

    // The default definition only counts a shift that *starts* inside the window, so the
    // same Friday-night shift is not a weekend shift under it.
    const underDefault = deriveCounters(
      s.schedule,
      baseCtx({ weekendDefinition: DEFAULT_WEEKEND }),
    );
    expect(underDefault.get(nurse.id)?.weekendsWorked).toBe(0);
  });
});

describe('holidays worked', () => {
  it('does not count the night before a holiday as a holiday shift', () => {
    const nurse = makeNurse();
    // The night shift starts Jan 5 and runs into the Jan 6 holiday morning; it is dated by
    // its start day, so it must not be counted as a holiday shift. The Jan 6 day shift is.
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-06'),
      ],
    });
    const counters = deriveCounters(
      s.schedule,
      baseCtx({ holidayDates: new Set([isoDate('2026-01-06')]) }),
    );
    expect(counters.get(nurse.id)?.holidaysWorked).toBe(1);
  });
});

describe('on-call shifts', () => {
  it('leaves on-call out of hours and nights', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, ON_CALL, '2026-01-05')],
    });
    const counters = deriveCounters(s.schedule, baseCtx());
    expect(counters.get(nurse.id)).toMatchObject({
      onCallShifts: 1,
      nightShifts: 0,
      totalHours: 0,
    });
  });
});

describe('undesirable shifts', () => {
  it('marks a night shift undesirable for a nurse who asked to avoid nights', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-01-05')],
    });
    const view = s.schedule.assignmentsFor(nurse.id)[0];
    if (!view) throw new Error('expected an assignment view');
    const avoidNights = {
      id: 'p1',
      nurseId: nurse.id,
      kind: 'avoid_shift_type' as const,
      shiftTypeId: NIGHT_12.id,
      weight: 3,
    };

    expect(isUndesirable(view, [avoidNights], DEFAULT_WEEKEND)).toBe(true);

    const counters = deriveCounters(s.schedule, baseCtx({ preferences: [avoidNights] }));
    expect(counters.get(nurse.id)?.undesirableShifts).toBe(1);
  });
});

describe('preference satisfaction', () => {
  it('scores a nurse who asked to avoid Mondays and worked two of the two Mondays at zero', () => {
    const nurse = makeNurse();
    // The default scenario period is 2026-01-04 (Sun) through 2026-01-17: exactly two Mondays,
    // 2026-01-05 and 2026-01-12.
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05'), assign(nurse.id, DAY_12, '2026-01-12')],
    });
    const avoidMondays = {
      id: 'p1',
      nurseId: nurse.id,
      kind: 'avoid_weekday' as const,
      weekday: 1 as const,
      weight: 2,
    };
    const score = preferenceSatisfaction(
      avoidMondays,
      s.schedule.assignmentsFor(nurse.id),
      s.dates,
      DEFAULT_WEEKEND,
    );
    expect(score).toBe(0);
  });

  it('gives full credit to a nurse who worked every shift of the type they asked for', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 3),
    });
    const preferDays = {
      id: 'p1',
      nurseId: nurse.id,
      kind: 'prefer_shift_type' as const,
      shiftTypeId: DAY_12.id,
      weight: 1,
    };
    const score = preferenceSatisfaction(
      preferDays,
      s.schedule.assignmentsFor(nurse.id),
      s.dates,
      DEFAULT_WEEKEND,
    );
    expect(score).toBe(1);
  });

  it('scores a nurse who asked to avoid weekends and worked both weekends of the period at zero', () => {
    const nurse = makeNurse();
    // Monday 2026-01-05 through Sunday 2026-01-18: two clean weekends (Jan 10-11, Jan 17-18)
    // and no boundary weekend leaking in from a partial week at either end.
    const s = scenario({
      nurses: [nurse],
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-18'),
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-10'),
        assign(nurse.id, DAY_12, '2026-01-11'),
        assign(nurse.id, DAY_12, '2026-01-17'),
        assign(nurse.id, DAY_12, '2026-01-18'),
      ],
    });
    const avoidWeekends = {
      id: 'p1',
      nurseId: nurse.id,
      kind: 'weekend_appetite' as const,
      level: -1,
      weight: 4,
    };
    const score = preferenceSatisfaction(
      avoidWeekends,
      s.schedule.assignmentsFor(nurse.id),
      s.dates,
      DEFAULT_WEEKEND,
    );
    expect(score).toBe(0);
  });

  it('gives full credit for a stretch length within one shift of what a nurse asked for', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 4),
    });
    const blockOfThree = {
      id: 'p1',
      nurseId: nurse.id,
      kind: 'preferred_block_length' as const,
      shifts: 3,
      weight: 1,
    };
    const score = preferenceSatisfaction(
      blockOfThree,
      s.schedule.assignmentsFor(nurse.id),
      s.dates,
      DEFAULT_WEEKEND,
    );
    expect(score).toBe(1);
  });

  it('gives a nurse with no preferences a full hit rate', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 3),
    });
    const counters = deriveCounters(s.schedule, baseCtx({ preferences: [] }));
    expect(counters.get(nurse.id)?.preferenceHitRate).toBe(1);
  });
});

describe('hours and overtime', () => {
  it('charges no overtime to a per-diem nurse', () => {
    const nurse = makeNurse({ contractedHoursPerPeriod: 0, employmentType: 'per_diem' });
    const s = scenario({
      nurses: [nurse],
      assignments: assignRun(nurse.id, DAY_12, '2026-01-05', 10), // 120h, way over a normal FTE
    });
    const counters = deriveCounters(s.schedule, baseCtx());
    expect(counters.get(nurse.id)?.overtimeHours).toBe(0);
  });

  it('scales contracted hours to a six-week period', () => {
    // testUnit.payPeriodDays is 14; a 42-day schedule period is three pay periods, so a
    // nurse's usual 72h contract scales to 72 * 42 / 14 = 216h. Scheduling 228h (19 twelves)
    // is 12h of overtime.
    expect(testUnit.payPeriodDays).toBe(14);
    const nurse = makeNurse({ contractedHoursPerPeriod: 72 });
    const start = isoDate('2026-01-04');
    const end = addDays(start, 41);
    const s = scenario({
      nurses: [nurse],
      startDate: start,
      endDate: end,
      assignments: assignRun(nurse.id, DAY_12, '2026-01-04', 19),
    });
    const counters = deriveCounters(s.schedule, baseCtx());
    expect(counters.get(nurse.id)?.totalHours).toBe(228);
    expect(counters.get(nurse.id)?.overtimeHours).toBe(12);
  });
});

describe('call-offs', () => {
  it('credits a call-off pickup', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05', { source: 'callout' })],
    });
    const counters = deriveCounters(s.schedule, baseCtx());
    expect(counters.get(nurse.id)?.callOutsCovered).toBe(1);
  });
});

describe('time-off requests', () => {
  it('counts approved and denied requests starting in the period only', () => {
    const nurse = makeNurse();
    const s = scenario({ nurses: [nurse] });
    const timeOff: CounterContext['timeOff'] = [
      {
        id: 'to-1',
        nurseId: nurse.id,
        startDate: isoDate('2026-01-05'),
        endDate: isoDate('2026-01-06'),
        type: 'pto',
        status: 'approved',
        enteredBy: 'manager',
        submittedAt: 0,
      },
      {
        id: 'to-2',
        nurseId: nurse.id,
        startDate: isoDate('2026-01-10'),
        endDate: isoDate('2026-01-10'),
        type: 'pto',
        status: 'denied',
        enteredBy: 'manager',
        submittedAt: 0,
      },
      {
        id: 'to-3',
        nurseId: nurse.id,
        // Starts before the period, so it must not be counted even though it's approved.
        startDate: isoDate('2026-01-01'),
        endDate: isoDate('2026-01-04'),
        type: 'pto',
        status: 'approved',
        enteredBy: 'manager',
        submittedAt: 0,
      },
    ];
    const counters = deriveCounters(s.schedule, baseCtx({ timeOff }));
    expect(counters.get(nurse.id)).toMatchObject({ requestsApproved: 1, requestsDenied: 1 });
  });
});

describe('coverage of the roster', () => {
  it('gives every nurse a row even with no shifts', () => {
    const withShifts = makeNurse();
    const idle = makeNurse();
    const s = scenario({
      nurses: [withShifts, idle],
      assignments: [assign(withShifts.id, DAY_12, '2026-01-05')],
    });
    const counters = deriveCounters(s.schedule, baseCtx());
    expect(counters.size).toBe(2);
    expect(counters.get(idle.id)).toMatchObject({
      nightShifts: 0,
      weekendsWorked: 0,
      holidaysWorked: 0,
      onCallShifts: 0,
      undesirableShifts: 0,
      totalHours: 0,
      overtimeHours: 0,
      preferenceHitRate: 1,
    });
  });
});
