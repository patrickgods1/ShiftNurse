/**
 * The DST suites (rules/, solver/, cost/, fairness/ dst.test.ts) assert wall-clock behaviour that
 * only differs from UTC on a host whose clock has DST; on a UTC host a regression to local-Date
 * arithmetic would pass them. This sentinel fails, saying why, if vitest.config.ts's TZ pin did
 * not take effect. It is the one place in core that constructs a local-time `Date` on purpose:
 * to read the host's offset, never for scheduling.
 */

import { describe, expect, it } from 'vitest';

describe('the test host clock', () => {
  // A developer trying another zone by hand opts out of the New York offsets.
  it.skipIf(process.env.SHIFTNURSE_TEST_TZ !== undefined)(
    'runs on a clock that springs forward and falls back, so the DST tests can fail',
    () => {
      // New York is UTC-5 (EST) in January and UTC-4 (EDT) in July; getTimezoneOffset counts
      // minutes behind UTC: 5 * 60 = 300 and 4 * 60 = 240.
      expect(
        new Date(2026, 0, 15, 12).getTimezoneOffset(),
        'vitest.config.ts pins TZ=America/New_York; without it the DST suites pass on a UTC host and check nothing',
      ).toBe(300);
      expect(new Date(2026, 6, 15, 12).getTimezoneOffset()).toBe(240);
    },
  );
});
