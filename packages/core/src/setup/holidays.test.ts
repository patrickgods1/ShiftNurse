import { describe, expect, it } from 'vitest';
import { usFederalHolidays } from './holidays.js';

describe('usFederalHolidays', () => {
  it('lists the eleven 2026 federal holidays on the dates printed on a 2026 calendar', () => {
    // Hand-checked against a 2026 wall calendar.
    expect(usFederalHolidays(2026).map((h) => [h.date, h.name])).toEqual([
      ['2026-01-01', "New Year's Day"],
      ['2026-01-19', 'Martin Luther King Jr. Day'],
      ['2026-02-16', "Presidents' Day"],
      ['2026-05-25', 'Memorial Day'],
      ['2026-06-19', 'Juneteenth'],
      ['2026-07-04', 'Independence Day'],
      ['2026-09-07', 'Labor Day'],
      ['2026-10-12', 'Columbus Day'],
      ['2026-11-11', 'Veterans Day'],
      ['2026-11-26', 'Thanksgiving Day'],
      ['2026-12-25', 'Christmas Day'],
    ]);
  });

  it('puts Memorial Day on May 31 when the month ends on a Monday', () => {
    // May 2027 has five Mondays: 3, 10, 17, 24, 31.
    const memorial = usFederalHolidays(2027).find((h) => h.name === 'Memorial Day');
    expect(memorial?.date).toBe('2027-05-31');
  });

  it('moves the floating holidays with the year', () => {
    const byName = new Map(usFederalHolidays(2027).map((h) => [h.name, h.date]));
    expect(byName.get('Martin Luther King Jr. Day')).toBe('2027-01-18');
    expect(byName.get('Thanksgiving Day')).toBe('2027-11-25');
    expect(byName.get('Labor Day')).toBe('2027-09-06');
  });

  it('marks the four holidays contracts usually rotate as major', () => {
    expect(
      usFederalHolidays(2026)
        .filter((h) => h.isMajor)
        .map((h) => h.name),
    ).toEqual(["New Year's Day", 'Independence Day', 'Thanksgiving Day', 'Christmas Day']);
  });
});
