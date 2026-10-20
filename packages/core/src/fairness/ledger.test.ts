import { beforeEach, describe, expect, it } from 'vitest';

import type { Preference } from '../domain/entities.js';
import { addDays, DEFAULT_WEEKEND, isoDate, type WeekendDefinition } from '../domain/time.js';
import {
  assign,
  assignRun,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testUnit,
  timeOff,
} from '../testing/fixtures.js';
import {
  deriveCounters,
  deriveOccurrences,
  hoursOverContract,
  isUndesirable,
  preferenceSatisfaction,
  preferencesBroken,
} from './ledger.js';
import type { CounterContext } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** A bare context with no holidays/preferences/time-off, for tests that only need one signal. */
function baseCtx(overrides: Partial<CounterContext> = {}): CounterContext {
  return {
    unit: testUnit,
    holidayDates: new Set(),
    holidayDateById: new Map(),
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

describe('holidays worked by the unit’s attribution', () => {
  // Christmas 2026-12-25 is the only holiday. Ana works the 12-24 night (19:00 Thu – 07:00 Fri):
  // 5 h on Christmas Eve, 7 h on Christmas. Bo works the 12-25 night: 5 h on Christmas, 7 h on
  // the 26th.
  const XMAS = isoDate('2026-12-25');
  const counted = (attribution?: 'start' | 'clock' | 'majority', prefs: Preference[] = []) => {
    const ana = makeNurse({ id: 'ana' });
    const bo = makeNurse({ id: 'bo' });
    const unit =
      attribution === undefined ? testUnit : { ...testUnit, holidayAttribution: attribution };
    const s = scenario({
      unit,
      startDate: isoDate('2026-12-20'),
      endDate: isoDate('2027-01-02'),
      nurses: [ana, bo],
      assignments: [assign('ana', NIGHT_12, '2026-12-24'), assign('bo', NIGHT_12, '2026-12-25')],
    });
    const ctx = baseCtx({
      unit,
      holidayDates: new Set([XMAS]),
      holidayDateById: new Map([['xmas', XMAS]]),
      preferences: prefs,
    });
    return {
      counters: deriveCounters(s.schedule, ctx),
      occurrences: deriveOccurrences(s.schedule, ctx),
    };
  };

  it('counts the Christmas Eve night as Christmas worked by the clock and by majority, not by start', () => {
    const worked = (attribution?: 'start' | 'clock' | 'majority') => {
      const { counters } = counted(attribution);
      return [counters.get('ana')!.holidaysWorked, counters.get('bo')!.holidaysWorked];
    };
    // Start: only Bo's night starts on Christmas. Clock: both nights touch Christmas. Majority:
    // Ana's has 7 of 12 hours on Christmas, Bo's only 5.
    expect(worked()).toEqual([0, 1]);
    expect(worked('start')).toEqual([0, 1]);
    expect(worked('clock')).toEqual([1, 1]);
    expect(worked('majority')).toEqual([1, 0]);
  });

  it('lists Christmas, not Christmas Eve, as the holiday the night into Christmas morning worked', () => {
    expect(counted('clock').occurrences.get('ana')!.holidays).toEqual(['2026-12-25']);
    expect(counted('start').occurrences.get('ana')!.holidays).toEqual([]);
  });

  it('meets a wish to work Christmas with the night into Christmas morning by the clock', () => {
    const wish: Preference = {
      id: 'p-ana-xmas',
      nurseId: 'ana',
      kind: 'holiday_appetite',
      holidayId: 'xmas',
      weight: 2,
    };
    expect(counted('clock', [wish]).counters.get('ana')!.preferenceHitRate).toBe(1);
    expect(counted('start', [wish]).counters.get('ana')!.preferenceHitRate).toBe(0);
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

describe('which preferences a shift goes against', () => {
  it('names both of Tyler’s preferences a Saturday night breaks, and none a Monday day', () => {
    const nurse = makeNurse();
    // 2026-01-10 is a Saturday; 2026-01-05 a Monday.
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-10'),
        assign(nurse.id, DAY_12, '2026-01-05'),
      ],
    });
    const avoidNights = {
      id: 'p1',
      nurseId: nurse.id,
      kind: 'avoid_shift_type' as const,
      shiftTypeId: NIGHT_12.id,
      weight: 5,
    };
    const fewerWeekends = {
      id: 'p2',
      nurseId: nurse.id,
      kind: 'weekend_appetite' as const,
      level: -1 as const,
      weight: 1,
    };
    const prefer = {
      id: 'p3',
      nurseId: nurse.id,
      kind: 'prefer_weekday' as const,
      weekday: 1 as const,
      weight: 2,
    };
    const views = s.schedule.assignmentsFor(nurse.id);
    const night = views.find((v) => v.assignment.date === '2026-01-10')!;
    const day = views.find((v) => v.assignment.date === '2026-01-05')!;
    const prefs = [avoidNights, fewerWeekends, prefer];
    expect(preferencesBroken(night, prefs, DEFAULT_WEEKEND).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(preferencesBroken(day, prefs, DEFAULT_WEEKEND)).toEqual([]);
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

describe('a nurse who wants to work a holiday', () => {
  // MLK Day 2026-01-12 falls in the default period (2026-01-04 to 2026-01-17); July 4th does not.
  const holidayDateById = new Map([
    ['mlk', isoDate('2026-01-12')],
    ['july4', isoDate('2026-07-04')],
  ]);
  const wants = (nurseId: string, holidayId: string, weight: number) => ({
    id: `p-${nurseId}-${holidayId}`,
    nurseId,
    kind: 'holiday_appetite' as const,
    holidayId,
    weight,
  });
  const preferNights = (nurseId: string) => ({
    id: `p-${nurseId}-nights`,
    nurseId,
    kind: 'prefer_shift_type' as const,
    shiftTypeId: NIGHT_12.id,
    weight: 1,
  });

  it('counts the wish as met for the volunteer who worked the holiday, and missed for the one who did not', () => {
    const worked = makeNurse();
    const missed = makeNurse();
    const s = scenario({
      nurses: [worked, missed],
      assignments: [
        assign(worked.id, DAY_12, '2026-01-05'),
        assign(worked.id, DAY_12, '2026-01-12'),
        assign(missed.id, DAY_12, '2026-01-05'),
        assign(missed.id, DAY_12, '2026-01-13'),
      ],
    });
    const counters = deriveCounters(
      s.schedule,
      baseCtx({
        holidayDateById,
        preferences: [wants(worked.id, 'mlk', 2), wants(missed.id, 'mlk', 2)],
      }),
    );
    expect(counters.get(worked.id)?.preferenceHitRate).toBe(1);
    expect(counters.get(missed.id)?.preferenceHitRate).toBe(0);
  });

  it('weighs the met holiday wish against a missed one: 3 of 4 points', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-12')],
    });
    const counters = deriveCounters(
      s.schedule,
      baseCtx({
        holidayDateById,
        preferences: [wants(nurse.id, 'mlk', 3), preferNights(nurse.id)],
      }),
    );
    expect(counters.get(nurse.id)?.preferenceHitRate).toBe(0.75);
  });

  it('leaves a wish to work a holiday outside the schedule out of the score', () => {
    const nurse = makeNurse();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-12')],
    });
    const counters = deriveCounters(
      s.schedule,
      baseCtx({
        holidayDateById,
        preferences: [wants(nurse.id, 'july4', 3), preferNights(nurse.id)],
      }),
    );
    expect(counters.get(nurse.id)?.preferenceHitRate).toBe(0);
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

describe('nights by tour', () => {
  it('counts a night by when it starts, not by the night-pay flag', () => {
    // Mon 5 Jan: a 15:00 evening tour paid as a night (Title 38). Wed 7 Jan: a 23:00 shift with
    // no night flag. tourOf('15:00') is evening and tourOf('23:00') is night, so one night.
    const eveningNightPay = { ...EVENING_8, id: 'st-e8-np', isNight: true };
    const lateUnflagged = { ...DAY_8, id: 'st-23', startTime: '23:00', isNight: false };
    const ana = makeNurse();
    const s = scenario({
      nurses: [ana],
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-11'),
      shiftTypes: [eveningNightPay, lateUnflagged],
      assignments: [
        assign(ana.id, eveningNightPay, '2026-01-05'),
        assign(ana.id, lateUnflagged, '2026-01-07'),
      ],
    });
    expect(deriveCounters(s.schedule, baseCtx()).get(ana.id)?.nightShifts).toBe(1);
    expect(deriveOccurrences(s.schedule, baseCtx()).get(ana.id)?.nights).toEqual(['2026-01-07']);
  });
});

describe('weekday preferences with a double', () => {
  it('reads a double on the only Monday as that Monday worked, not twice', () => {
    // Mon 5 – Sun 11 Jan holds one Monday. Ana avoids Mondays and works a D8 and an E8 on it:
    // one of one Mondays worked, so 1 − 1/1 = 0.
    const ana = makeNurse();
    const s = scenario({
      nurses: [ana],
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-11'),
      shiftTypes: [DAY_8, EVENING_8],
      assignments: [assign(ana.id, DAY_8, '2026-01-05'), assign(ana.id, EVENING_8, '2026-01-05')],
    });
    const counters = deriveCounters(
      s.schedule,
      baseCtx({
        preferences: [{ id: 'p1', nurseId: ana.id, kind: 'avoid_weekday', weekday: 1, weight: 1 }],
      }),
    );
    expect(counters.get(ana.id)?.preferenceHitRate).toBe(0);
  });
});

describe('hours over contract', () => {
  it('charges hours over contract only to contracted nurses', () => {
    // 72h per 14-day pay period over a 14-day period; seven 12s are 84h: 84 − 72 = 12 over.
    // The per-diem nurse works the same 84h and has no contract to be over.
    const ana = makeNurse({ contractedHoursPerPeriod: 72 });
    const pd = makeNurse({ contractedHoursPerPeriod: 0, employmentType: 'per_diem' });
    const s = scenario({
      nurses: [ana, pd],
      assignments: [
        ...assignRun(ana.id, DAY_12, '2026-01-05', 7),
        ...assignRun(pd.id, DAY_12, '2026-01-05', 7),
      ],
    });
    const counters = deriveCounters(s.schedule, baseCtx());
    expect(counters.get(ana.id)?.overtimeHours).toBe(12);
    expect(counters.get(pd.id)?.overtimeHours).toBe(0);
    // Six weeks: 72 × 42 / 14 = 216h contracted, so 230h worked is 14 over.
    expect(hoursOverContract({ contractedHoursPerPeriod: 72 }, 230, 42, 14)).toBe(14);
    expect(hoursOverContract({ contractedHoursPerPeriod: 0 }, 230, 42, 14)).toBe(0);
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

describe('availability on the ledger row', () => {
  it('records that a nurse on FMLA for the whole period was not there', () => {
    const ana = makeNurse({ id: 'ana' });
    const bea = makeNurse({ id: 'bea' });
    // The default scenario period is 2026-01-04 to 2026-01-17: 14 days.
    const s = scenario({
      nurses: [ana, bea],
      assignments: [assign(ana.id, DAY_12, '2026-01-05')],
    });
    const fmla = timeOff('bea', '2026-01-04', '2026-01-17', { type: 'fmla' });
    const counters = deriveCounters(s.schedule, baseCtx({ timeOff: [fmla] }));
    expect(counters.get('bea')).toMatchObject({ periodDays: 14, availableDays: 0 });
    expect(counters.get('ana')).toMatchObject({ periodDays: 14, availableDays: 14 });
  });
});

describe("where a nurse's burden fell", () => {
  it('lists the exact nights, weekend days and holidays Ana worked, once each', () => {
    const ana = makeNurse();
    // Fri Oct 2 night; Sat Oct 3 day AND night (one weekend day, two shifts); Sun Oct 4 day;
    // Mon Oct 5 day on a holiday. Out of date order on purpose.
    const s = scenario({
      nurses: [ana],
      assignments: [
        assign(ana.id, DAY_12, '2026-10-05'),
        assign(ana.id, NIGHT_12, '2026-10-03'),
        assign(ana.id, DAY_12, '2026-10-03'),
        assign(ana.id, DAY_12, '2026-10-04'),
        assign(ana.id, NIGHT_12, '2026-10-02'),
      ],
    });
    const ctx = baseCtx({ holidayDates: new Set([isoDate('2026-10-05')]) });

    const found = deriveOccurrences(s.schedule, ctx).get(ana.id);
    expect(found).toEqual({
      nights: ['2026-10-02', '2026-10-03'],
      weekends: ['2026-10-03', '2026-10-04'],
      holidays: ['2026-10-05'],
    });

    // Nights and holidays are counted per shift, so they match the ledger; weekends are counted
    // per weekend (one here) while the list is per weekend day (two).
    const counters = deriveCounters(s.schedule, ctx).get(ana.id)!;
    expect(counters.nightShifts).toBe(2);
    expect(counters.holidaysWorked).toBe(1);
    expect(counters.weekendsWorked).toBe(1);
  });

  it('does not count standby on a holiday, or a shift carried in from the last period', () => {
    const ana = makeNurse();
    const s = scenario({
      nurses: [ana],
      assignments: [assign(ana.id, ON_CALL, '2026-01-06')],
      // Sat Jan 3 night, a holiday: the previous period's, so it is nobody's burden here.
      priorAssignments: [assign(ana.id, NIGHT_12, '2026-01-03')],
    });
    const ctx = baseCtx({ holidayDates: new Set([isoDate('2026-01-06'), isoDate('2026-01-03')]) });
    expect(deriveOccurrences(s.schedule, ctx).get(ana.id)).toEqual({
      nights: [],
      weekends: [],
      holidays: [],
    });
  });

  it('lists a Friday night that runs into the weekend under Friday, the day it starts', () => {
    const ana = makeNurse();
    // 19:00 Fri Jan 9 -> 07:00 Sat Jan 10.
    const s = scenario({
      nurses: [ana],
      assignments: [assign(ana.id, NIGHT_12, '2026-01-09')],
    });
    const overlaps: WeekendDefinition = {
      startWeekday: 6,
      startMinute: 0,
      durationMinutes: 2 * 1440,
      mode: 'overlaps',
    };
    expect(
      deriveOccurrences(s.schedule, baseCtx({ weekendDefinition: overlaps })).get(ana.id)?.weekends,
    ).toEqual(['2026-01-09']);
    // Under the default (starts within) it is not a weekend shift at all.
    expect(deriveOccurrences(s.schedule, baseCtx()).get(ana.id)?.weekends).toEqual([]);
  });
});

describe('a nurse on the Baylor weekend plan', () => {
  it('carries no weekend or holiday burden for the weekends the plan is made of', () => {
    // Two weekends worked (10–11 and 17 Jan), and Sat 17 Jan a holiday. A standard nurse on the
    // same shifts carries 2 weekends and 1 holiday; the Baylor nurse, none: they were hired for it.
    const baylor = makeNurse({ id: 'bay', scheduleKind: 'va_baylor' });
    const standard = makeNurse({ id: 'std' });
    const dates = ['2026-01-10', '2026-01-11', '2026-01-17'];
    const s = scenario({
      nurses: [baylor, standard],
      assignments: dates.flatMap((d) => [assign('bay', DAY_12, d), assign('std', DAY_12, d)]),
    });
    const ctx = baseCtx({ holidayDates: new Set([isoDate('2026-01-17')]) });
    const counters = deriveCounters(s.schedule, ctx);
    expect(counters.get('bay')).toMatchObject({ weekendsWorked: 0, holidaysWorked: 0 });
    expect(counters.get('std')).toMatchObject({ weekendsWorked: 2, holidaysWorked: 1 });
    // The dates behind the counters agree with them.
    expect(deriveOccurrences(s.schedule, ctx).get('bay')).toMatchObject({
      weekends: [],
      holidays: [],
    });
  });
});
