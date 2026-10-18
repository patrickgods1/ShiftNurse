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
import {
  addDays,
  compareDates,
  dayNumber,
  daysBetween,
  fromDayNumber,
  isoDate,
  weekdayOf,
} from './time.js';

const SEED = 20260101;
const CASES = 400;
const FIRST = 0; // 1970-01-01
const LAST = Math.round(Date.UTC(2100, 11, 31) / 86_400_000);

// Oracles written from the calendar's own rules, so a slip in time.ts cannot hide in a shared formula.
function parts(iso: string): [number, number, number] {
  return [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
}

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function monthLength(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function nextDay(iso: string): string {
  const [y, m, d] = parts(iso);
  if (d < monthLength(y, m)) return fmt(y, m, d + 1);
  return m < 12 ? fmt(y, m + 1, 1) : fmt(y + 1, 1, 1);
}

function prevDay(iso: string): string {
  const [y, m, d] = parts(iso);
  if (d > 1) return fmt(y, m, d - 1);
  if (m > 1) return fmt(y, m - 1, monthLength(y, m - 1));
  return fmt(y - 1, 12, 31);
}

/** Sakamoto's method; 0 is Sunday. */
function sakamoto(iso: string): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const [y0, m, d] = parts(iso);
  const y = m < 3 ? y0 - 1 : y0;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1]! + d) % 7;
}

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

  it('names the weekdays a calendar shows', () => {
    expect(weekdayOf(isoDate('1970-01-01'))).toBe(4);
    expect(weekdayOf(isoDate('2000-02-29'))).toBe(2);
    expect(weekdayOf(isoDate('2024-02-29'))).toBe(4);
    expect(weekdayOf(isoDate('2026-03-08'))).toBe(0); // US spring-forward
    expect(weekdayOf(isoDate('2026-11-01'))).toBe(0); // US fall-back
    expect(weekdayOf(isoDate('2100-02-28'))).toBe(0);
    expect(weekdayOf(isoDate('2100-03-01'))).toBe(1); // 2100 is not a leap year
  });

  it('names the same weekday as the calendar does', () => {
    const rng = new Rng(SEED + 1);
    for (let i = 0; i < CASES; i++) {
      const d = rng.nextInt(FIRST, LAST);
      for (let pass = 0; pass < 2; pass++) {
        const date = fromDayNumber(d);
        expect(weekdayOf(date), `seed ${SEED + 1} case ${i} pass ${pass} day ${d}`).toBe(
          sakamoto(date),
        );
      }
    }
  });

  it('moves a date forward or back by whole days without drifting', () => {
    const rng = new Rng(SEED + 2);
    for (let i = 0; i < CASES; i++) {
      const d = rng.nextInt(FIRST, LAST);
      const k = rng.nextInt(-800, 800);
      const date = fromDayNumber(d);
      let expected: string = date;
      for (let n = 0; n < Math.abs(k); n++)
        expected = k > 0 ? nextDay(expected) : prevDay(expected);
      for (let pass = 0; pass < 2; pass++) {
        expect(addDays(date, k), `seed ${SEED + 2} case ${i} pass ${pass} day ${d} k ${k}`).toBe(
          expected,
        );
      }
    }
  });

  it('steps from one day to the next with addDays and daysBetween agreeing', () => {
    const rng = new Rng(SEED + 4);
    for (let i = 0; i < CASES; i++) {
      const date = fromDayNumber(rng.nextInt(FIRST, LAST));
      const k = rng.nextInt(-800, 800);
      expect(daysBetween(date, addDays(date, k)), `seed ${SEED + 4} case ${i} ${date} k ${k}`).toBe(
        k,
      );
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
