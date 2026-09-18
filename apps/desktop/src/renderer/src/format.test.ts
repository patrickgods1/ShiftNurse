import { describe, expect, it } from 'vitest';
import { formatDate, formatDateWithWeekday } from './format.js';

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
