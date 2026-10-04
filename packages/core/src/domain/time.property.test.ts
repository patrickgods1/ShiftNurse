/**
 * Invariant: date arithmetic is exact and agrees with the calendar for every day from 1970 to
 * 2100, on the first call and when the answer comes from the memo cache.
 *
 * Why it matters: every rest, weekend, pay-period and leave judgement is built on `dayNumber`,
 * `addDays` and `weekdayOf`; a one-day slip on a leap day or century year would put a shift in
 * the wrong week and nobody would see an error, only a wrong schedule.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../solver/rng.js';
import { addDays, compareDates, dayNumber, daysBetween, fromDayNumber, weekdayOf } from './time.js';

const SEED = 20260101;
const CASES = 400;
const FIRST = 0; // 1970-01-01
const LAST = Math.round(Date.UTC(2100, 11, 31) / 86_400_000);

describe('date arithmetic over 1970 to 2100', () => {
  it('turns any day number into a date and back to the same day, every time', () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < CASES; i++) {
      const d = rng.nextInt(FIRST, LAST);
      for (let pass = 0; pass < 2; pass++) {
        const date = fromDayNumber(d);
        expect(dayNumber(date), `seed ${SEED} case ${i} pass ${pass} day ${d}`).toBe(d);
      }
    }
  });

  it('names the same weekday as the calendar does', () => {
    const rng = new Rng(SEED + 1);
    for (let i = 0; i < CASES; i++) {
      const d = rng.nextInt(FIRST, LAST);
      for (let pass = 0; pass < 2; pass++) {
        expect(
          weekdayOf(fromDayNumber(d)),
          `seed ${SEED + 1} case ${i} pass ${pass} day ${d}`,
        ).toBe(new Date(d * 86_400_000).getUTCDay());
      }
    }
  });

  it('moves a date forward or back by whole days without drifting', () => {
    const rng = new Rng(SEED + 2);
    for (let i = 0; i < CASES; i++) {
      const d = rng.nextInt(FIRST, LAST);
      const k = rng.nextInt(-800, 800);
      const date = fromDayNumber(d);
      for (let pass = 0; pass < 2; pass++) {
        expect(addDays(date, k), `seed ${SEED + 2} case ${i} pass ${pass} day ${d} k ${k}`).toBe(
          fromDayNumber(d + k),
        );
      }
    }
  });

  it('orders two dates the way the days between them say it should', () => {
    const rng = new Rng(SEED + 3);
    for (let i = 0; i < CASES; i++) {
      const a = fromDayNumber(rng.nextInt(FIRST, LAST));
      // Half the time pick a near neighbour so equal and adjacent dates are exercised.
      const b = rng.chance(0.5)
        ? addDays(a, rng.nextInt(-3, 3))
        : fromDayNumber(rng.nextInt(FIRST, LAST));
      for (let pass = 0; pass < 2; pass++) {
        expect(
          Math.sign(compareDates(a, b)),
          `seed ${SEED + 3} case ${i} pass ${pass} ${a} vs ${b}`,
        ).toBe(Math.sign(-daysBetween(a, b)) + 0);
      }
    }
  });
});
