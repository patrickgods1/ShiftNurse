import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { hostDstTransitions } from './host-dst.js';

// Phase 1's sentinel: a developer may run another zone by hand, where these dates differ.
const inPinnedZone = process.env.SHIFTNURSE_TEST_TZ === undefined;

describe('the host clock calendar', () => {
  it.skipIf(!inPinnedZone)(
    'finds the autumn clock change at 02:00 on Sunday 1 November 2026',
    () => {
      // 2026-11-01 is day 20758; 20758 * 1440 + 120 = 29_891_640. The clock goes back an hour.
      expect(hostDstTransitions(isoDate('2026-10-25'), isoDate('2026-11-07'))).toEqual([
        { atMinute: 29_891_640, deltaMinutes: -60 },
      ]);
    },
  );

  it.skipIf(!inPinnedZone)('finds the spring clock change at 02:00 on Sunday 8 March 2026', () => {
    // 2026-03-08 is day 20520; 20520 * 1440 + 120 = 29_548_920. The clock jumps ahead an hour.
    expect(hostDstTransitions(isoDate('2026-03-01'), isoDate('2026-03-14'))).toEqual([
      { atMinute: 29_548_920, deltaMinutes: 60 },
    ]);
  });

  it.skipIf(!inPinnedZone)('finds no clock change in June', () => {
    expect(hostDstTransitions(isoDate('2026-06-01'), isoDate('2026-06-30'))).toEqual([]);
  });
});
