import { describe, expect, it } from 'vitest';

import { type IsoDate, isoDate, shiftWindow } from '../domain/time.js';
import { NIGHT_12 } from '../testing/fixtures.js';
import { attributedHolidayDates, holidayMinutesOn } from './holiday-attribution.js';
import type { DstTransition } from './real-minutes.js';

const isXmas = (d: IsoDate) => d === '2026-12-25';
const EVE = isoDate('2026-12-24');
const XMAS = isoDate('2026-12-25');

describe('which day a shift across midnight works for holiday purposes', () => {
  it('gives the night into Christmas morning no holiday by its start', () => {
    expect(attributedHolidayDates(EVE, NIGHT_12, 'start', isXmas)).toEqual([]);
  });

  it('gives the night into Christmas morning to Christmas by the clock', () => {
    expect(attributedHolidayDates(EVE, NIGHT_12, 'clock', isXmas)).toEqual(['2026-12-25']);
  });

  it('gives the night into Christmas morning to Christmas by majority: seven of twelve hours', () => {
    // 19:00–24:00 is 5h on the 24th, 00:00–07:00 is 7h on the 25th.
    expect(attributedHolidayDates(EVE, NIGHT_12, 'majority', isXmas)).toEqual(['2026-12-25']);
  });

  it('gives the Christmas night to Boxing Day by majority: five of twelve hours on Christmas', () => {
    expect(attributedHolidayDates(XMAS, NIGHT_12, 'majority', isXmas)).toEqual([]);
  });

  it('breaks a six-and-six tie toward the day the shift starts', () => {
    // 18:00–06:00: 6h on each day.
    const evening12 = { startTime: '18:00', durationHours: 12 };
    expect(attributedHolidayDates(XMAS, evening12, 'majority', isXmas)).toEqual(['2026-12-25']);
    expect(attributedHolidayDates(EVE, evening12, 'majority', isXmas)).toEqual([]);
  });

  it('counts seven hours of the Christmas Eve night on Christmas by the clock', () => {
    // 00:00–07:00 on the 25th: 420 minutes.
    expect(holidayMinutesOn(EVE, NIGHT_12, shiftWindow(EVE, NIGHT_12), 'clock', isXmas)).toEqual(
      new Map([['2026-12-25', 420]]),
    );
  });

  it('names both days when a night runs from Christmas Eve into Christmas and both are holidays', () => {
    const both = (d: IsoDate) => d === '2026-12-24' || d === '2026-12-25';
    expect(attributedHolidayDates(EVE, NIGHT_12, 'clock', both)).toEqual([
      '2026-12-24',
      '2026-12-25',
    ]);
  });
});

describe('the minutes of a shift that earn holiday pay', () => {
  it('gives the whole Christmas night to Christmas by its start', () => {
    // 19:00–07:00: 720 minutes, all to the 25th.
    expect(holidayMinutesOn(XMAS, NIGHT_12, shiftWindow(XMAS, NIGHT_12), 'start', isXmas)).toEqual(
      new Map([['2026-12-25', 720]]),
    );
  });

  it('gives the whole Christmas Eve night to Christmas by majority', () => {
    // 7 of its 12 hours are on the 25th, so all 720 minutes go there.
    expect(holidayMinutesOn(EVE, NIGHT_12, shiftWindow(EVE, NIGHT_12), 'majority', isXmas)).toEqual(
      new Map([['2026-12-25', 720]]),
    );
  });

  // 2026-11-01 is day 20758; the clock falls back at 02:00: 20758 × 1440 + 120.
  const FALL: DstTransition = { atMinute: 29_891_640, deltaMinutes: -60 };
  const SAT = isoDate('2026-10-31');

  it('counts the fall-back night’s repeated hour when the whole night is the holiday’s', () => {
    // Saturday 2026-10-31 a holiday by start: 720 wall minutes plus the repeated hour, 780.
    const isSat = (d: IsoDate) => d === '2026-10-31';
    expect(
      holidayMinutesOn(SAT, NIGHT_12, shiftWindow(SAT, NIGHT_12), 'start', isSat, [FALL]),
    ).toEqual(new Map([['2026-10-31', 780]]));
  });

  it('counts the repeated hour on the Sunday the clock falls back, by the clock', () => {
    // Sunday 2026-11-01 a holiday: 00:00–07:00 is 420 wall minutes plus the repeated hour, 480.
    const isSun = (d: IsoDate) => d === '2026-11-01';
    expect(
      holidayMinutesOn(SAT, NIGHT_12, shiftWindow(SAT, NIGHT_12), 'clock', isSun, [FALL]),
    ).toEqual(new Map([['2026-11-01', 480]]));
  });
});
