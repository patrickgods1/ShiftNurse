import { describe, expect, it } from 'vitest';

import {
  addDays,
  compareDates,
  crossesMidnight,
  DEFAULT_WEEKEND,
  dateInRange,
  datesInRange,
  datesTouchedByWindow,
  dayNumber,
  daysBetween,
  formatTimeOfDay,
  fromDayNumber,
  isIsoDate,
  isoDate,
  isWeekendWindow,
  MINUTES_PER_DAY,
  maxDate,
  minDate,
  parseTimeOfDay,
  rangesOverlap,
  restMinutesBetween,
  type ShiftTiming,
  shiftWindow,
  type WeekendDefinition,
  weekdayOf,
  weekendKey,
  windowDurationMinutes,
  windowEndDate,
  windowsOverlap,
} from './time.js';

const DAY_12H: ShiftTiming = { startTime: '07:00', durationHours: 12 };
const NIGHT_12H: ShiftTiming = { startTime: '19:00', durationHours: 12 };
const DAY_8H: ShiftTiming = { startTime: '07:00', durationHours: 8 };
const EVENING_8H: ShiftTiming = { startTime: '15:00', durationHours: 8 };
const NIGHT_8H: ShiftTiming = { startTime: '23:00', durationHours: 8 };

describe('isoDate', () => {
  it('accepts well-formed dates', () => {
    expect(isoDate('2026-09-17')).toBe('2026-09-17');
  });

  it('rejects malformed strings', () => {
    expect(() => isoDate('2026-9-17')).toThrow();
    expect(() => isoDate('17/09/2026')).toThrow();
    expect(() => isoDate('')).toThrow();
  });

  it('rejects dates that do not exist rather than silently rolling over', () => {
    expect(() => isoDate('2026-02-30')).toThrow();
    expect(() => isoDate('2026-13-01')).toThrow();
    expect(() => isoDate('2025-02-29')).toThrow();
  });

  it('accepts a real leap day', () => {
    expect(isoDate('2028-02-29')).toBe('2028-02-29');
  });

  it('isIsoDate agrees without throwing', () => {
    expect(isIsoDate('2026-09-17')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
  });
});

describe('calendar arithmetic', () => {
  it('round-trips through day numbers', () => {
    const d = isoDate('2026-09-17');
    expect(fromDayNumber(dayNumber(d))).toBe(d);
  });

  it('orders dates by the calendar across month, year and leap-day boundaries', () => {
    const d = isoDate;
    expect(compareDates(d('2026-01-31'), d('2026-02-01'))).toBeLessThan(0);
    expect(compareDates(d('2027-01-01'), d('2026-12-31'))).toBeGreaterThan(0);
    expect(compareDates(d('2028-02-29'), d('2028-02-29'))).toBe(0);
    expect(minDate(d('2026-10-09'), d('2026-09-30'))).toBe('2026-09-30');
    expect(maxDate(d('2026-10-09'), d('2026-09-30'))).toBe('2026-10-09');
    expect(dateInRange(d('2026-03-01'), d('2026-02-28'), d('2026-03-01'))).toBe(true);
    expect(dateInRange(d('2026-03-02'), d('2026-02-28'), d('2026-03-01'))).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays(isoDate('2026-01-31'), 1)).toBe('2026-02-01');
    expect(addDays(isoDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(isoDate('2027-01-01'), -1)).toBe('2026-12-31');
  });

  it('adds days across a leap day', () => {
    expect(addDays(isoDate('2028-02-28'), 1)).toBe('2028-02-29');
    expect(addDays(isoDate('2028-02-29'), 1)).toBe('2028-03-01');
  });

  it('measures days between dates', () => {
    expect(daysBetween(isoDate('2026-09-17'), isoDate('2026-09-24'))).toBe(7);
    expect(daysBetween(isoDate('2026-09-24'), isoDate('2026-09-17'))).toBe(-7);
  });

  it('identifies weekdays', () => {
    expect(weekdayOf(isoDate('2026-09-17'))).toBe(4); // a Thursday
    expect(weekdayOf(isoDate('2026-09-19'))).toBe(6); // Saturday
    expect(weekdayOf(isoDate('2026-09-20'))).toBe(0); // Sunday
  });

  it('builds inclusive date ranges', () => {
    expect(datesInRange(isoDate('2026-09-17'), isoDate('2026-09-19'))).toEqual([
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
    ]);
    expect(datesInRange(isoDate('2026-09-17'), isoDate('2026-09-17'))).toHaveLength(1);
    expect(datesInRange(isoDate('2026-09-19'), isoDate('2026-09-17'))).toEqual([]);
  });

  it('tests range containment inclusively at both ends', () => {
    const start = isoDate('2026-09-17');
    const end = isoDate('2026-09-19');
    expect(dateInRange(start, start, end)).toBe(true);
    expect(dateInRange(end, start, end)).toBe(true);
    expect(dateInRange(isoDate('2026-09-16'), start, end)).toBe(false);
  });

  it('detects overlapping ranges, including single-day touches', () => {
    expect(
      rangesOverlap(
        isoDate('2026-09-17'),
        isoDate('2026-09-20'),
        isoDate('2026-09-20'),
        isoDate('2026-09-25'),
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        isoDate('2026-09-17'),
        isoDate('2026-09-19'),
        isoDate('2026-09-20'),
        isoDate('2026-09-25'),
      ),
    ).toBe(false);
  });
});

describe('times of day', () => {
  it('parses and formats', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('07:00')).toBe(420);
    expect(parseTimeOfDay('19:30')).toBe(1170);
    expect(formatTimeOfDay(1170)).toBe('19:30');
    expect(formatTimeOfDay(0)).toBe('00:00');
  });

  it('wraps formatted values past midnight', () => {
    expect(formatTimeOfDay(MINUTES_PER_DAY + 420)).toBe('07:00');
  });

  it('rejects impossible clock times', () => {
    expect(() => parseTimeOfDay('24:00')).toThrow();
    expect(() => parseTimeOfDay('12:60')).toThrow();
    expect(() => parseTimeOfDay('7:00')).toThrow();
  });
});

describe('shift windows', () => {
  it('identifies which shifts cross midnight', () => {
    expect(crossesMidnight(DAY_12H)).toBe(false);
    expect(crossesMidnight(NIGHT_12H)).toBe(true);
    expect(crossesMidnight(EVENING_8H)).toBe(false); // 15:00 + 8h = 23:00 exactly
    expect(crossesMidnight(NIGHT_8H)).toBe(true);
  });

  it('gives a day shift a 12-hour window on its own date', () => {
    const w = shiftWindow(isoDate('2026-09-17'), DAY_12H);
    expect(windowDurationMinutes(w)).toBe(720);
    expect(datesTouchedByWindow(w)).toEqual(['2026-09-17']);
    expect(windowEndDate(w)).toBe('2026-09-17');
  });

  it('carries a night shift into the following calendar day', () => {
    const w = shiftWindow(isoDate('2026-09-17'), NIGHT_12H);
    expect(windowDurationMinutes(w)).toBe(720);
    expect(datesTouchedByWindow(w)).toEqual(['2026-09-17', '2026-09-18']);
    expect(windowEndDate(w)).toBe('2026-09-18');
  });

  it('treats a shift ending exactly at midnight as ending that same day', () => {
    const w = shiftWindow(isoDate('2026-09-17'), EVENING_8H);
    expect(windowEndDate(w)).toBe('2026-09-17');
    expect(datesTouchedByWindow(w)).toEqual(['2026-09-17']);
  });

  it('rejects a non-positive duration', () => {
    expect(() =>
      shiftWindow(isoDate('2026-09-17'), { startTime: '07:00', durationHours: 0 }),
    ).toThrow();
  });

  describe('DST', () => {
    // US spring-forward 2026-03-08, fall-back 2026-11-01. A night shift spanning either
    // one is 11 or 13 actual elapsed hours, but the contract — and payroll — call it 12.
    it('keeps a night shift 12 hours across spring-forward', () => {
      const w = shiftWindow(isoDate('2026-03-07'), NIGHT_12H);
      expect(windowDurationMinutes(w)).toBe(720);
    });

    it('keeps a night shift 12 hours across fall-back', () => {
      const w = shiftWindow(isoDate('2026-10-31'), NIGHT_12H);
      expect(windowDurationMinutes(w)).toBe(720);
    });

    it('keeps rest periods stable across a DST boundary', () => {
      const night = shiftWindow(isoDate('2026-03-07'), NIGHT_12H); // ends 07:00 Sunday
      const nextDay = shiftWindow(isoDate('2026-03-08'), EVENING_8H); // starts 15:00 Sunday
      expect(restMinutesBetween(night, nextDay)).toBe(8 * 60);
    });
  });
});

describe('overlap and rest', () => {
  it('treats windows as half-open: back-to-back shifts do not overlap', () => {
    const night = shiftWindow(isoDate('2026-09-17'), NIGHT_12H); // ends 07:00 on the 18th
    const day = shiftWindow(isoDate('2026-09-18'), DAY_12H); // starts 07:00 on the 18th
    expect(windowsOverlap(night, day)).toBe(false);
    expect(restMinutesBetween(night, day)).toBe(0);
  });

  it('detects genuine overlap', () => {
    const day = shiftWindow(isoDate('2026-09-17'), DAY_12H);
    const evening = shiftWindow(isoDate('2026-09-17'), EVENING_8H);
    expect(windowsOverlap(day, evening)).toBe(true);
    expect(restMinutesBetween(day, evening)).toBeLessThan(0);
  });

  it('measures rest between consecutive day shifts', () => {
    const a = shiftWindow(isoDate('2026-09-17'), DAY_12H);
    const b = shiftWindow(isoDate('2026-09-18'), DAY_12H);
    expect(restMinutesBetween(a, b)).toBe(12 * 60);
  });

  it('catches the classic night-to-day turnaround as zero rest', () => {
    const night = shiftWindow(isoDate('2026-09-17'), NIGHT_8H); // 23:00 → 07:00
    const day = shiftWindow(isoDate('2026-09-18'), DAY_8H); // 07:00 → 15:00
    expect(restMinutesBetween(night, day)).toBe(0);
  });

  it('is order-independent', () => {
    const a = shiftWindow(isoDate('2026-09-17'), DAY_12H);
    const b = shiftWindow(isoDate('2026-09-18'), DAY_12H);
    expect(restMinutesBetween(b, a)).toBe(restMinutesBetween(a, b));
  });
});

describe('weekends', () => {
  it('counts a Saturday day shift', () => {
    const w = shiftWindow(isoDate('2026-09-19'), DAY_12H); // Saturday
    expect(isWeekendWindow(w)).toBe(true);
  });

  it('counts a Sunday night shift even though it ends on Monday', () => {
    const w = shiftWindow(isoDate('2026-09-20'), NIGHT_12H); // Sunday 19:00
    expect(isWeekendWindow(w)).toBe(true);
  });

  it('does not count a Friday night shift under the default definition', () => {
    const w = shiftWindow(isoDate('2026-09-18'), NIGHT_12H); // Friday 19:00
    expect(isWeekendWindow(w)).toBe(false);
  });

  it('does count a Friday night shift when the contract says the weekend starts Friday 19:00', () => {
    const fridayStart: WeekendDefinition = {
      startWeekday: 5,
      startMinute: 19 * 60,
      durationMinutes: 2 * MINUTES_PER_DAY + 5 * 60,
      mode: 'starts_within',
    };
    const w = shiftWindow(isoDate('2026-09-18'), NIGHT_12H);
    expect(isWeekendWindow(w, fridayStart)).toBe(true);
  });

  it("counts a Friday night shift under 'overlaps' since it runs into Saturday", () => {
    const overlapping: WeekendDefinition = { ...DEFAULT_WEEKEND, mode: 'overlaps' };
    const w = shiftWindow(isoDate('2026-09-18'), NIGHT_12H);
    expect(isWeekendWindow(w, overlapping)).toBe(true);
  });

  it('does not count a Monday day shift', () => {
    const w = shiftWindow(isoDate('2026-09-21'), DAY_12H); // Monday
    expect(isWeekendWindow(w)).toBe(false);
  });

  it('groups Saturday and Sunday shifts under the same weekend key', () => {
    const sat = shiftWindow(isoDate('2026-09-19'), DAY_12H);
    const sun = shiftWindow(isoDate('2026-09-20'), NIGHT_12H);
    expect(weekendKey(sat)).toBe('2026-09-19');
    expect(weekendKey(sun)).toBe('2026-09-19');
  });

  it('gives consecutive weekends different keys, seven days apart', () => {
    const thisWeekend = weekendKey(shiftWindow(isoDate('2026-09-19'), DAY_12H));
    const nextWeekend = weekendKey(shiftWindow(isoDate('2026-09-26'), DAY_12H));
    expect(thisWeekend).not.toBe(nextWeekend);
    expect(daysBetween(isoDate(thisWeekend!), isoDate(nextWeekend!))).toBe(7);
  });

  it('returns no key for a weekday shift', () => {
    expect(weekendKey(shiftWindow(isoDate('2026-09-17'), DAY_12H))).toBeNull();
  });
});
