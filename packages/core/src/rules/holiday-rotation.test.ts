import { beforeEach, describe, expect, it } from 'vitest';

import type { Holiday } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
} from '../testing/fixtures.js';
import { holidayRotationFacts, previousOccurrence } from './holiday-rotation.js';
import { evaluateSchedule } from './registry.js';
import type { HolidayWorkRecord } from './types.js';

function holiday(
  id: string,
  date: string,
  name: string,
  isMajor: boolean,
  pairedHolidayId: string | null = null,
): Holiday {
  return { id, unitId: 'unit-1', date: isoDate(date), name, isMajor, pairedHolidayId };
}

const XMAS_2025 = holiday('xmas-2025', '2025-12-25', 'Christmas Day', true);
const EVE_2025 = holiday('eve-2025', '2025-12-24', 'Christmas Eve', false);
const XMAS_2026 = holiday('xmas-2026', '2026-12-25', 'Christmas Day', true);
const EVE_2026 = holiday('eve-2026', '2026-12-24', 'Christmas Eve', false, 'xmas-2026');
const HOLIDAYS = [XMAS_2025, EVE_2025, XMAS_2026, EVE_2026];

let ana: ReturnType<typeof makeNurse>;
let ben: ReturnType<typeof makeNurse>;

beforeEach(() => {
  resetFixtureCounters();
  ana = makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Reyes' });
  ben = makeNurse({ id: 'ben', firstName: 'Ben', lastName: 'Okafor' });
});

function rotationViolations(
  options: ScenarioOptions & { holidayWork?: HolidayWorkRecord[] },
  params: Record<string, unknown> = {},
) {
  const s = scenario({
    startDate: isoDate('2026-12-20'),
    endDate: isoDate('2027-01-02'),
    nurses: [ana, ben],
    holidays: HOLIDAYS,
    ...options,
    ruleParams: { 'holiday-rotation': params },
  });
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
    (v) => v.ruleId === 'holiday-rotation',
  );
}

describe('major holidays rotate year to year', () => {
  it('flags the nurse who worked last Christmas and is scheduled again', () => {
    const found = rotationViolations({
      holidayWork: [{ holidayId: XMAS_2025.id, nurseId: ana.id }],
      assignments: [assign(ana.id, DAY_12, '2026-12-25'), assign(ben.id, DAY_12, '2026-12-25')],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe('holiday_rotation');
    expect(found[0]!.severity).toBe('soft');
    expect(found[0]!.nurseIds).toEqual([ana.id]);
    expect(found[0]!.dates).toEqual([isoDate('2026-12-25')]);
    expect(found[0]!.message).toContain('Christmas Day');
    expect(found[0]!.message).toContain('Ana Reyes');
  });

  it('gives Christmas to the nurse who had it off last year without complaint', () => {
    const found = rotationViolations({
      holidayWork: [{ holidayId: XMAS_2025.id, nurseId: ana.id }],
      assignments: [assign(ben.id, DAY_12, '2026-12-25')],
    });
    expect(found).toEqual([]);
  });

  it('owes nothing to a nurse with no record for last year, such as a new hire', () => {
    const found = rotationViolations({
      holidayWork: [],
      assignments: [assign(ana.id, DAY_12, '2026-12-25')],
    });
    expect(found).toEqual([]);
  });

  it('does not count the night into Christmas morning as working Christmas', () => {
    // The night of the 24th runs to 07:00 on the 25th; shifts are dated by the day they start.
    const found = rotationViolations({
      holidayWork: [{ holidayId: XMAS_2025.id, nurseId: ana.id }],
      assignments: [assign(ana.id, NIGHT_12, '2026-12-24')],
    });
    expect(found).toEqual([]);
  });

  it('does not count standby on Christmas as working it', () => {
    const found = rotationViolations({
      holidayWork: [{ holidayId: XMAS_2025.id, nurseId: ana.id }],
      assignments: [assign(ana.id, ON_CALL, '2026-12-25')],
    });
    expect(found).toEqual([]);
  });

  it('can be turned off for major holidays', () => {
    const found = rotationViolations(
      {
        holidayWork: [{ holidayId: XMAS_2025.id, nurseId: ana.id }],
        assignments: [assign(ana.id, DAY_12, '2026-12-25')],
      },
      { rotateMajorHolidays: false },
    );
    expect(found).toEqual([]);
  });
});

describe('minor holidays', () => {
  it('rotate on their own when not paired with a major holiday', () => {
    const found = rotationViolations({
      holidayWork: [{ holidayId: EVE_2025.id, nurseId: ana.id }],
      assignments: [assign(ana.id, DAY_12, '2026-12-24')],
    });
    expect(found.map((v) => v.code)).toEqual(['holiday_rotation']);
    expect(found[0]!.message).toContain('Christmas Eve');
  });

  it('can be left out of the rotation', () => {
    const found = rotationViolations(
      {
        holidayWork: [{ holidayId: EVE_2025.id, nurseId: ana.id }],
        assignments: [assign(ana.id, DAY_12, '2026-12-24')],
      },
      { rotateMinorHolidays: false },
    );
    expect(found).toEqual([]);
  });

  it('when paired, keep whoever works Christmas off Christmas Eve', () => {
    const found = rotationViolations(
      {
        assignments: [assign(ana.id, DAY_12, '2026-12-24'), assign(ana.id, DAY_12, '2026-12-25')],
      },
      { pairMinorWithMajor: true },
    );
    expect(found.map((v) => v.code)).toEqual(['holiday_pair_both']);
    expect(found[0]!.dates).toEqual([isoDate('2026-12-24'), isoDate('2026-12-25')]);
    expect(found[0]!.message).toContain('Christmas Eve');
    expect(found[0]!.message).toContain('Christmas Day');
  });

  it('when paired, are fine for someone working only one of the two', () => {
    const found = rotationViolations(
      { assignments: [assign(ana.id, DAY_12, '2026-12-24'), assign(ben.id, DAY_12, '2026-12-25')] },
      { pairMinorWithMajor: true },
    );
    expect(found).toEqual([]);
  });

  it('when paired, follow the pairing instead of last year’s Christmas Eve', () => {
    const found = rotationViolations(
      {
        holidayWork: [{ holidayId: EVE_2025.id, nurseId: ana.id }],
        assignments: [assign(ana.id, DAY_12, '2026-12-24')],
      },
      { pairMinorWithMajor: true },
    );
    expect(found).toEqual([]);
  });

  it('ignore a pairing while pairing is off', () => {
    const found = rotationViolations({
      assignments: [assign(ana.id, DAY_12, '2026-12-24'), assign(ana.id, DAY_12, '2026-12-25')],
    });
    expect(found).toEqual([]);
  });

  it('judge a pair split across periods from the lookback tail', () => {
    // Christmas Eve was in the last period; Christmas opens this one.
    const found = rotationViolations(
      {
        startDate: isoDate('2026-12-25'),
        priorAssignments: [assign(ana.id, DAY_12, '2026-12-24', { periodId: 'period-0' })],
        assignments: [assign(ana.id, DAY_12, '2026-12-25')],
      },
      { pairMinorWithMajor: true },
    );
    expect(found.map((v) => v.code)).toEqual(['holiday_pair_both']);
  });

  describe('paired months apart', () => {
    // A unit that splits the year: whoever works Memorial Day is off Thanksgiving.
    const THANKSGIVING = holiday('tg-2026', '2026-11-26', 'Thanksgiving Day', true);
    const MEMORIAL = holiday('mem-2026', '2026-05-25', 'Memorial Day', false, THANKSGIVING.id);
    const november = {
      startDate: isoDate('2026-11-22'),
      endDate: isoDate('2026-12-05'),
      holidays: [THANKSGIVING, MEMORIAL],
    };

    it('keeps whoever worked Memorial Day off Thanksgiving, from the published record', () => {
      const found = rotationViolations(
        {
          ...november,
          holidayWork: [{ holidayId: MEMORIAL.id, nurseId: ana.id }],
          assignments: [assign(ana.id, DAY_12, '2026-11-26'), assign(ben.id, DAY_12, '2026-11-26')],
        },
        { pairMinorWithMajor: true },
      );
      expect(found.map((v) => [v.code, v.nurseIds[0]])).toEqual([['holiday_pair_both', ana.id]]);
      expect(found[0]!.dates).toEqual([isoDate('2026-05-25'), isoDate('2026-11-26')]);
      // Only the shift this period can change is flagged.
      expect(found[0]!.assignmentIds).toHaveLength(1);
    });

    it('leaves the pair for a later period to judge while its other half is still ahead', () => {
      // May's schedule cannot know who will work Thanksgiving.
      const found = rotationViolations(
        {
          startDate: isoDate('2026-05-24'),
          endDate: isoDate('2026-06-06'),
          holidays: [THANKSGIVING, MEMORIAL],
          assignments: [assign(ana.id, DAY_12, '2026-05-25')],
        },
        { pairMinorWithMajor: true },
      );
      expect(found).toEqual([]);
    });
  });
});

describe('a nurse on the Baylor weekend plan', () => {
  // VA Handbook 5011 gives a Baylor nurse no holiday entitlement, so there is nothing to rotate.
  const baylor = () =>
    makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Reyes', scheduleKind: 'va_baylor' });

  it('is not owed Christmas off for having worked it last year', () => {
    ana = baylor();
    // Christmas 2026 is a Friday: the night 12 that starts on it is a Baylor tour.
    const found = rotationViolations({
      holidayWork: [{ holidayId: XMAS_2025.id, nurseId: ana.id }],
      assignments: [assign(ana.id, NIGHT_12, '2026-12-25')],
    });
    expect(found).toEqual([]);
  });

  it('is not kept off a paired Christmas Eve', () => {
    ana = baylor();
    const found = rotationViolations(
      {
        assignments: [assign(ana.id, DAY_12, '2026-12-24'), assign(ana.id, NIGHT_12, '2026-12-25')],
      },
      { pairMinorWithMajor: true },
    );
    expect(found).toEqual([]);
  });

  it('is owed nothing in what the solvers price', () => {
    ana = baylor();
    const s = scenario({
      startDate: isoDate('2026-12-20'),
      endDate: isoDate('2027-01-02'),
      nurses: [ana, ben],
      holidays: HOLIDAYS,
      holidayWork: [
        { holidayId: XMAS_2025.id, nurseId: ana.id },
        { holidayId: XMAS_2025.id, nurseId: ben.id },
      ],
    });
    const facts = holidayRotationFacts(
      s.ctx,
      { rotateMajorHolidays: true, rotateMinorHolidays: true, pairMinorWithMajor: false },
      { start: isoDate('2026-12-20'), end: isoDate('2027-01-02') },
    );
    expect([...facts.owedOff.keys()]).toEqual([ben.id]);
  });
});

describe('last year’s holiday', () => {
  it('is the same holiday by name, about a year earlier', () => {
    const previous = previousOccurrence(XMAS_2026, [
      XMAS_2025,
      holiday('xmas-2024', '2024-12-25', 'Christmas Day', true),
      holiday('other', '2025-12-26', 'Boxing Day', false),
    ]);
    expect(previous?.id).toBe(XMAS_2025.id);
  });

  it('matches regardless of capitals and spacing', () => {
    const previous = previousOccurrence(XMAS_2026, [
      holiday('x', '2025-12-25', '  christmas   day ', true),
    ]);
    expect(previous?.id).toBe('x');
  });

  it('matches “New Years Day” to “New Year’s Day”, ignoring punctuation', () => {
    const previous = previousOccurrence(holiday('ny-27', '2027-01-01', 'New Years Day', true), [
      holiday('ny-26', '2026-01-01', "New Year's Day", true),
    ]);
    expect(previous?.id).toBe('ny-26');
  });

  it('is not one two years back', () => {
    const previous = previousOccurrence(XMAS_2026, [
      holiday('xmas-2024', '2024-12-25', 'Christmas Day', true),
    ]);
    expect(previous).toBeUndefined();
  });

  it('follows a holiday that moves, like Thanksgiving', () => {
    const previous = previousOccurrence(holiday('tg-26', '2026-11-26', 'Thanksgiving Day', true), [
      holiday('tg-25', '2025-11-27', 'Thanksgiving Day', true),
    ]);
    expect(previous?.id).toBe('tg-25');
  });
});
