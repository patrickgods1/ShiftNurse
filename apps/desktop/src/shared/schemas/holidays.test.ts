import { describe, expect, it } from 'vitest';
import { holidaysSchemas } from './holidays.js';

describe('a holiday arriving over IPC', () => {
  it('accepts Christmas Eve paired with Christmas Day', () => {
    const input = {
      unitId: 'u-1',
      date: '2026-12-24',
      name: 'Christmas Eve',
      isMajor: false,
      pairedHolidayId: 'h-xmas',
    };
    expect(holidaysSchemas.create.safeParse([input]).success).toBe(true);
  });

  it('refuses a date that is not on the calendar', () => {
    const input = { unitId: 'u-1', date: '2026-02-30', name: 'Mystery Day', isMajor: true };
    expect(holidaysSchemas.create.safeParse([input]).success).toBe(false);
  });

  it('lets a rename unpair the holiday but not move its date', () => {
    expect(holidaysSchemas.update.safeParse(['h-1', { pairedHolidayId: null }]).success).toBe(true);
    expect(holidaysSchemas.update.safeParse(['h-1', { date: '2026-12-25' }]).success).toBe(false);
  });

  it('accepts a proposed year with a minor holiday waiting on a partner in the plan', () => {
    const year = {
      holidays: [
        { key: 'a', date: '2027-12-25', name: 'Christmas Day', isMajor: true, pairWith: null },
        {
          key: 'b',
          date: '2027-12-24',
          name: 'Christmas Eve',
          isMajor: false,
          pairWith: { key: 'a' },
        },
      ],
      repairs: [{ minorId: 'h-9', pairWith: { holidayId: 'h-1' } }],
    };
    expect(holidaysSchemas.addYear.safeParse(['u-1', year]).success).toBe(true);
  });
});
