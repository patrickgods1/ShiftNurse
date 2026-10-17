import { describe, expect, it } from 'vitest';
import type { ShiftWindow } from '../domain/time.js';
import { latestEndingBefore } from './preceding.js';

// Minutes from Monday 00:00; only the shape of the timeline matters here.
const MON = 0;
const TUE = 1440;
const at = (day: number, hour: number) => day + hour * 60;

function shift(name: string, startMinute: number, endMinute: number) {
  const window: ShiftWindow = { startMinute, endMinute };
  return { name, window };
}

describe('what a shift follows', () => {
  it('finds the night shift as what a 09:00 start follows, not the short shift nested inside it', () => {
    const a = shift('A', at(MON, 19), at(TUE, 7));
    const b = shift('B', at(MON, 20), at(MON, 22));
    const c = shift('C', at(TUE, 9), at(TUE, 17));
    // B starts after A, so it follows A. For C both started earlier; A ends 07:00 Tue, after
    // B's 22:00 Mon.
    expect(latestEndingBefore([a, b, c])).toEqual([[], [a], [a]]);
  });

  it('returns both shifts that end at the same minute', () => {
    const a = shift('A', at(MON, 19), at(TUE, 7));
    const b = shift('B', at(TUE, 4), at(TUE, 7));
    const c = shift('C', at(TUE, 19), at(TUE + 1440, 7));
    // A and B both end 07:00 Tue.
    expect(latestEndingBefore([a, b, c])[2]).toEqual([a, b]);
  });

  it('never treats two shifts starting at the same minute as one before the other', () => {
    const a = shift('A', at(MON, 19), at(TUE, 7));
    const b = shift('B', at(MON, 19), at(MON, 23));
    expect(latestEndingBefore([a, b])).toEqual([[], []]);
    expect(latestEndingBefore([b, a])).toEqual([[], []]);
  });
});
