import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { DAY_12, EVENING_8, MID_8, NIGHT_8, NIGHT_12 } from '../testing/fixtures.js';
import { containingDate, coveringShift, withinShiftProblem } from './cover.js';

const WED = isoDate('2026-01-07');

describe('which shift covers which', () => {
  it('puts an 11:00–19:00 mid inside that day’s 07:00–19:00 day 12', () => {
    expect(containingDate(MID_8, DAY_12, WED)).toBe('2026-01-07');
  });

  it('puts a 23:00–07:00 night 8 inside the 19:00 night 12 that began the same evening', () => {
    expect(containingDate(NIGHT_8, NIGHT_12, WED)).toBe('2026-01-07');
  });

  it('puts a 03:00–07:00 early shift inside the night 12 that began the evening before', () => {
    const early = { ...MID_8, startTime: '03:00', durationHours: 4 };
    expect(containingDate(early, NIGHT_12, WED)).toBe('2026-01-06');
  });

  it('does not treat a 15:00–23:00 evening as inside a day 12 that ends at 19:00', () => {
    expect(containingDate(EVENING_8, DAY_12, WED)).toBeUndefined();
  });

  it('finds no cover for a standalone shift', () => {
    expect(coveringShift(DAY_12, WED, new Map([[DAY_12.id, DAY_12]]))).toBeUndefined();
  });
});

describe('what may run inside what', () => {
  it('accepts the mid 8 inside the day 12', () => {
    expect(withinShiftProblem(MID_8, DAY_12)).toBeUndefined();
  });

  it('refuses a shift whose hours run past the containing shift', () => {
    const late = { ...MID_8, startTime: '13:00' }; // 13:00–21:00, past 19:00
    expect(withinShiftProblem(late, DAY_12)).toMatch(/does not fit inside/);
  });

  it('refuses a chain: cover comes from a standalone shift', () => {
    const inner = { ...MID_8, id: 'st-inner', withinShiftTypeId: MID_8.id, durationHours: 4 };
    expect(withinShiftProblem(inner, MID_8)).toMatch(/itself runs inside another/);
  });
});
