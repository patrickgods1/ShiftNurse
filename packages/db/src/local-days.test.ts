import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { localInstant } from './local-days.js';

describe('a wall-clock time on a local day', () => {
  it('places 7 a.m. on the spring-forward Sunday 23 hours after 7 a.m. the day before', () => {
    // 2026's second Sunday of March is the 8th: 07:00 EDT is 11:00 UTC, the day before 07:00 EST
    // is 12:00 UTC.
    expect(localInstant(isoDate('2026-03-08'), '07:00')).toBe(1772967600000);
    expect(localInstant(isoDate('2026-03-07'), '07:00')).toBe(1772884800000);
    expect(
      localInstant(isoDate('2026-03-08'), '07:00') - localInstant(isoDate('2026-03-07'), '07:00'),
    ).toBe(23 * 3_600_000);
  });

  it('refuses a time of day that is not one', () => {
    for (const bad of ['7:00', '24:00', '07:60']) {
      expect(() => localInstant(isoDate('2026-03-08'), bad)).toThrow(/is not a time of day/);
    }
    expect(() => localInstant('2026-02-30' as never, '07:00')).toThrow(/is not a date/);
  });
});
