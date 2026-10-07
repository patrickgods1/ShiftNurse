import { makeNurse } from '@shiftnurse/core/testing';
import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateWithWeekday,
  formatHoldover,
  fteLabel,
  instantFormat,
  listName,
  periodLabel,
  periodRange,
} from './format.js';

describe('display date formatting', () => {
  it('prints the correct weekday — 2026-09-20 is a Sunday, not a Wednesday', () => {
    expect(formatDateWithWeekday('2026-09-20')).toBe('Sun, Sep 20');
    expect(formatDateWithWeekday('1970-01-01')).toBe('Thu, Jan 1');
    expect(formatDateWithWeekday('2026-09-18')).toBe('Fri, Sep 18');
  });

  it('prints a long date without touching the local timezone', () => {
    expect(formatDate('2026-03-05')).toBe('Mar 5, 2026');
  });
});

describe('people and periods as the unit names them', () => {
  it('lists a nurse surname first, the way the roster is called', () => {
    expect(listName(makeNurse({ firstName: 'Grace', lastName: 'Campbell' }))).toBe(
      'Campbell, Grace',
    );
  });

  it('calls a per-diem nurse per diem rather than "0.00 FTE"', () => {
    expect(fteLabel(makeNurse({ employmentType: 'per_diem', fte: 0 }))).toBe('Per diem');
    expect(fteLabel(makeNurse({ employmentType: 'agency', fte: 0 }))).toBe('Agency');
    expect(fteLabel(makeNurse({ fte: 0.9 }))).toBe('0.9 FTE');
    expect(fteLabel(makeNurse({ fte: 1 }))).toBe('1.0 FTE');
  });

  const period = (name: string, startDate: string, endDate: string) =>
    ({ name, startDate, endDate }) as Parameters<typeof periodLabel>[0];

  it('writes a period as its dates, with the year once when it does not change', () => {
    expect(periodRange(period('x', '2026-10-04', '2026-11-14'))).toBe('Oct 4 – Nov 14, 2026');
    expect(periodRange(period('x', '2026-12-27', '2027-01-09'))).toBe('Dec 27, 2026 – Jan 9, 2027');
  });

  it('replaces a name the app made up from ISO dates, and keeps one the manager typed', () => {
    expect(
      periodLabel(period('Schedule 2026-10-04 to 2026-11-14', '2026-10-04', '2026-11-14')),
    ).toBe('Oct 4 – Nov 14, 2026');
    expect(periodLabel(period('Pay period 2026-09-20', '2026-09-20', '2026-10-03'))).toBe(
      'Sep 20 – Oct 3, 2026',
    );
    expect(periodLabel(period('Fall block', '2026-10-04', '2026-11-14'))).toBe(
      'Fall block (Oct 4 – Nov 14, 2026)',
    );
  });
});

describe('instant formatting', () => {
  it('shows a backup taken at 5:35 PM UTC with its date and time', () => {
    // 2026-10-03T17:35:00Z; ICU may put a narrow no-break space before PM.
    const text = instantFormat('en-US', 'UTC').format(Date.UTC(2026, 9, 3, 17, 35));
    expect(text.replace(/\s/g, ' ')).toBe('Oct 3, 2026, 5:35 PM');
  });
});

describe('holdover length', () => {
  it('writes an hour and a half the way a charge nurse would say it', () => {
    expect(formatHoldover(90)).toBe('1h 30m');
  });

  it('drops the hours for a quarter-hour stay and the minutes for a clean two hours', () => {
    expect(formatHoldover(45)).toBe('45m');
    expect(formatHoldover(120)).toBe('2h');
    expect(formatHoldover(720)).toBe('12h');
  });
});
