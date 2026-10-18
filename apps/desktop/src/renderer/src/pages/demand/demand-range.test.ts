import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { rangeProblem } from './demand-range.js';

describe('the Staffing needs date range', () => {
  it('refuses a range that ends before it starts', () => {
    expect(rangeProblem(isoDate('2026-10-10'), isoDate('2026-10-01'))).toBe(
      'The end date is before the start date.',
    );
  });

  it('shows up to 120 days and no more', () => {
    // Jan 31 + Feb 28 + Mar 31 + Apr 30 = 120 days to Apr 30 inclusive; May 1 is the 121st.
    expect(rangeProblem(isoDate('2026-01-01'), isoDate('2026-04-30'))).toBeUndefined();
    expect(rangeProblem(isoDate('2026-01-01'), isoDate('2026-05-01'))).toBe(
      'Show at most 120 days at a time; this range is 121 days.',
    );
  });

  it('refuses the runaway range a half-typed year makes', () => {
    expect(rangeProblem(isoDate('0202-10-16'), isoDate('2026-12-12'))).toContain('666261 days');
  });

  it('accepts a single day', () => {
    expect(rangeProblem(isoDate('2026-10-10'), isoDate('2026-10-10'))).toBeUndefined();
  });
});
