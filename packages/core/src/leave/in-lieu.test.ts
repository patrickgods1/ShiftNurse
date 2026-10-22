/**
 * A holiday on a full-time federal nurse's day off moves to a nearby workday. Dates are 2026:
 * Sun 4 Jan, Mon 5, Tue 6, Wed 7, Thu 8, Fri 9, Sat 10, Sun 11, Mon 12; Fri 2 Jan is the week before.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Holiday } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
} from '../testing/fixtures.js';
import { inLieuHolidayDates } from './in-lieu.js';

beforeEach(() => {
  resetFixtureCounters();
});

const holiday = (id: string, date: string): Holiday => ({
  id,
  unitId: 'unit-1',
  date: isoDate(date),
  name: id,
  isMajor: true,
  pairedHolidayId: null,
});

/** The nurse's timeline from day shifts on these dates and on-call on `onCallDates`. */
function timelineOf(
  workDates: string[],
  nurse = makeNurse({ id: 'ada' }),
  onCallDates: string[] = [],
) {
  const s = scenario({
    nurses: [nurse],
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    priorAssignments: workDates
      .filter((d) => d < '2026-01-04')
      .map((d) => assign(nurse.id, DAY_12, d, { periodId: 'prev' })),
    assignments: [
      ...workDates.filter((d) => d >= '2026-01-04').map((d) => assign(nurse.id, DAY_12, d)),
      ...onCallDates.map((d) => assign(nurse.id, ON_CALL, d)),
    ],
  });
  return { timeline: s.schedule.timelineFor(nurse.id), nurse };
}

const MON_THU = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];

describe('the in-lieu day of a holiday on a full-time nurse’s day off', () => {
  it('gives the Thursday to a Monday-to-Thursday nurse when the holiday is Friday', () => {
    const { timeline, nurse } = timelineOf(MON_THU);
    const found = inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')]);
    expect([...found]).toEqual([['h', '2026-01-08']]);
  });

  it('gives the Monday after to a nurse whose holiday falls on a Sunday', () => {
    // Sun 11 Jan is the holiday; she also works Sat 10 Jan, but a Sunday looks forward only, so
    // Mon 12 Jan is the first day she works after it.
    const { timeline, nurse } = timelineOf(['2026-01-10', '2026-01-12', '2026-01-13']);
    expect([...inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-11')])]).toEqual([
      ['h', '2026-01-12'],
    ]);
  });

  it('gives the Friday before to a Monday-to-Friday nurse when the holiday is Saturday', () => {
    const { timeline, nurse } = timelineOf([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
    ]);
    expect([...inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-10')])]).toEqual([
      ['h', '2026-01-09'],
    ]);
  });

  it('gives nothing to a part-time nurse', () => {
    const { timeline, nurse } = timelineOf(
      MON_THU,
      makeNurse({ id: 'ada', employmentType: 'part_time' }),
    );
    expect(inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')]).size).toBe(0);
  });

  it('gives nothing to a per-diem nurse', () => {
    const { timeline, nurse } = timelineOf(
      MON_THU,
      makeNurse({ id: 'ada', employmentType: 'per_diem' }),
    );
    expect(inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')]).size).toBe(0);
  });

  it('gives nothing to a nurse on the Baylor plan', () => {
    const { timeline, nurse } = timelineOf(
      MON_THU,
      makeNurse({ id: 'ada', scheduleKind: 'va_baylor' }),
    );
    expect(inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')]).size).toBe(0);
  });

  it('gives nothing to a nurse on a 72/80 schedule who is not scheduled that day', () => {
    const { timeline, nurse } = timelineOf(
      MON_THU,
      makeNurse({ id: 'ada', scheduleKind: 'va_72_80' }),
    );
    expect(inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')]).size).toBe(0);
  });

  it('gives nothing when she works the holiday itself', () => {
    const { timeline, nurse } = timelineOf([...MON_THU, '2026-01-09']);
    expect(inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')]).size).toBe(0);
  });

  it('does not count a day on call as a workday', () => {
    // Fri 9 Jan holiday; she is on call Thu 8 only, so the search goes back to Wed 7.
    const { timeline, nurse } = timelineOf(['2026-01-05', '2026-01-07'], undefined, ['2026-01-08']);
    expect([...inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')])]).toEqual([
      ['h', '2026-01-07'],
    ]);
  });

  it('counts a shift from the previous schedule as a workday', () => {
    // Sat 3 Jan holiday; Fri 2 Jan is in the lookback and is the day before.
    const { timeline, nurse } = timelineOf(['2026-01-02']);
    expect([...inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-03')])]).toEqual([
      ['h', '2026-01-02'],
    ]);
  });

  it('counts a shift on another unit as a day she works', () => {
    // Fri 9 Jan holiday; her only shift that week is Thu 8 Jan on 5 West, which still makes it
    // her in-lieu day. It reaches the timeline as an inactive `elsewhere` copy of the shift type.
    const west = { ...DAY_12, id: 'elsewhere:st-d12', active: false, elsewhere: true as const };
    const nurse = makeNurse({ id: 'ada' });
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [...testShiftTypes, west],
      priorAssignments: [assign('ada', west, '2026-01-08', { periodId: 'prev', isLocked: true })],
    });
    const timeline = s.schedule.timelineFor('ada');
    expect(timeline).toHaveLength(1);
    expect([...inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')])]).toEqual([
      ['h', '2026-01-08'],
    ]);
  });

  it('gives nothing when she works nowhere within six days', () => {
    // Fri 2 Jan is seven days before Fri 9 Jan, one beyond the search; Mon 12 is after it.
    const { timeline, nurse } = timelineOf(['2026-01-02', '2026-01-12']);
    expect(inLieuHolidayDates(nurse, timeline, [holiday('h', '2026-01-09')]).size).toBe(0);
  });
});
