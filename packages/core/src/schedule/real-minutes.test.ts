import { describe, expect, it } from 'vitest';

import { type DstTransition, realMinutesIn } from './real-minutes.js';

// Day numbers by hand: 2026-01-01 is day 20454 (56 × 365 + 14 leap days). 2026-03-07 is
// 20454 + 31 + 28 + 6 = 20519 and 2026-03-08 is 20520; 2026-10-31 is 20454 + 303 = 20757 and
// 2026-11-01 is 20758. US clocks change at 02:00 local, wall minute 120 of the day.
/** 2026-03-08 02:00 springs to 03:00: 20520 × 1440 + 120. */
const SPRING: DstTransition = { atMinute: 29_548_920, deltaMinutes: 60 };
/** 2026-11-01 02:00 falls back to 01:00: 20758 × 1440 + 120. */
const FALL: DstTransition = { atMinute: 29_891_640, deltaMinutes: -60 };

describe('hours actually worked across a clock change', () => {
  it('counts the fall-back night as thirteen hours', () => {
    // 2026-10-31 19:00 (20757 × 1440 + 1140) to 2026-11-01 07:00: 720 wall minutes plus the
    // repeated hour 01:00–02:00, wholly inside.
    expect(realMinutesIn({ startMinute: 29_891_220, endMinute: 29_891_940 }, [FALL])).toBe(780);
  });

  it('counts the spring-forward night as eleven hours', () => {
    // 2026-03-07 19:00 (20519 × 1440 + 1140) to 2026-03-08 07:00: 720 less the skipped
    // 02:00–03:00.
    expect(realMinutesIn({ startMinute: 29_548_500, endMinute: 29_549_220 }, [SPRING])).toBe(660);
  });

  it('leaves the Sunday day shift after the clock change at twelve hours', () => {
    // 2026-11-01 07:00 (20758 × 1440 + 420) to 19:00.
    expect(realMinutesIn({ startMinute: 29_891_940, endMinute: 29_892_660 }, [FALL])).toBe(720);
  });

  it('leaves every window alone when the host has no clock changes', () => {
    expect(realMinutesIn({ startMinute: 29_891_220, endMinute: 29_891_940 }, [])).toBe(720);
  });
});
