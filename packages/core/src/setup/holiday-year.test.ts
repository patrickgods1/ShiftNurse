import { describe, expect, it } from 'vitest';

import type { Holiday } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { planHolidayYear } from './holiday-year.js';

function h(
  id: string,
  date: string,
  name: string,
  isMajor: boolean,
  pairedHolidayId: string | null = null,
): Holiday {
  return { id, unitId: 'u', date: isoDate(date), name, isMajor, pairedHolidayId };
}

const planned = (plan: ReturnType<typeof planHolidayYear>) =>
  plan.holidays.map((p) => [p.date, p.name, p.isMajor]);

describe('adding next year’s holidays', () => {
  const year2026 = [
    h('mem-26', '2026-05-25', 'Memorial Day', false),
    h('picnic-26', '2026-05-08', 'Nurses Week Picnic', false),
    h('tg-26', '2026-11-26', 'Thanksgiving Day', true),
    h('eve-26', '2026-12-24', 'Christmas Eve', false, 'xmas-26'),
    h('xmas-26', '2026-12-25', 'Christmas Day', true),
  ];

  it('rolls last year forward, moving the floating holidays to their new dates', () => {
    const plan = planHolidayYear(year2026, 2027);
    // Memorial Day 2027 is the last Monday of May (the 31st); Thanksgiving the fourth Thursday
    // of November (the 25th). The picnic and Christmas keep their month and day.
    expect(planned(plan)).toEqual([
      ['2027-05-08', 'Nurses Week Picnic', false],
      ['2027-05-31', 'Memorial Day', false],
      ['2027-11-25', 'Thanksgiving Day', true],
      ['2027-12-24', 'Christmas Eve', false],
      ['2027-12-25', 'Christmas Day', true],
    ]);
  });

  it('carries Christmas Eve’s pairing to the new Christmas Day', () => {
    const plan = planHolidayYear(year2026, 2027);
    const eve = plan.holidays.find((p) => p.name === 'Christmas Eve')!;
    const xmas = plan.holidays.find((p) => p.name === 'Christmas Day')!;
    expect(eve.pairWith).toEqual({ key: xmas.key });
    expect(xmas.pairWith).toBeNull();
  });

  it('starts from the US federal holidays when there is no year before', () => {
    const plan = planHolidayYear([], 2027);
    expect(plan.holidays).toHaveLength(11);
    expect(plan.holidays.filter((p) => p.isMajor).map((p) => p.name)).toEqual([
      "New Year's Day",
      'Independence Day',
      'Thanksgiving Day',
      'Christmas Day',
    ]);
    expect(plan.holidays.every((p) => p.from === 'federal')).toBe(true);
  });

  it('skips what next year already has, by date or by name', () => {
    const plan = planHolidayYear(
      [
        ...year2026,
        h('xmas-27', '2027-12-25', 'Christmas Day', true),
        h('tg-27-typo', '2027-11-24', 'thanksgiving day', true),
      ],
      2027,
    );
    expect(plan.holidays.map((p) => p.name)).toEqual([
      'Nurses Week Picnic',
      'Memorial Day',
      'Christmas Eve',
    ]);
    expect(plan.skipped.map((s) => s.name).sort()).toEqual(['Christmas Day', 'Thanksgiving Day']);
    // Christmas Eve still pairs with the Christmas Day already on the list.
    expect(plan.holidays.find((p) => p.name === 'Christmas Eve')?.pairWith).toEqual({
      holidayId: 'xmas-27',
    });
  });

  it('moves a leap-day holiday to the 28th in a common year', () => {
    const plan = planHolidayYear([h('leap', '2028-02-29', 'Leap Day Social', false)], 2029);
    expect(planned(plan)).toEqual([['2029-02-28', 'Leap Day Social', false]]);
  });

  describe('a pair across the year end', () => {
    // New Year's Eve 2025 was paired with New Year's Day 2026. When 2026 was added, New Year's
    // Eve 2026 could not pair yet: New Year's Day 2027 did not exist.
    const holidays = [
      h('nyd-26', '2026-01-01', "New Year's Day", true),
      h('nye-25', '2025-12-31', "New Year's Eve", false, 'nyd-26'),
      h('nye-26', '2026-12-31', "New Year's Eve", false),
      h('nyd-25', '2025-01-01', "New Year's Day", true),
    ];

    it('pairs last New Year’s Eve with the New Year’s Day being added', () => {
      const plan = planHolidayYear(holidays, 2027);
      const nyd = plan.holidays.find((p) => p.name === "New Year's Day")!;
      expect(nyd.date).toBe('2027-01-01');
      expect(plan.repairs).toEqual([{ minorId: 'nye-26', pairWith: { key: nyd.key } }]);
    });

    it('says the new New Year’s Eve waits for next year’s New Year’s Day', () => {
      const plan = planHolidayYear(holidays, 2027);
      expect(plan.holidays.find((p) => p.name === "New Year's Eve")?.pairWith).toBeNull();
      expect(plan.unpaired).toEqual([
        { name: "New Year's Eve", partner: "New Year's Day", year: 2028 },
      ]);
    });
  });
});
