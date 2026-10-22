/**
 * Where a night that runs over a week's edge puts its hours. Expected values are hand-counted:
 * 2026-03-07 and 2026-10-31 are Saturdays, the clocks spring forward at 02:00 on Sunday
 * 2026-03-08 and fall back at 02:00 on Sunday 2026-11-01.
 */

import { describe, expect, it } from 'vitest';
import { type IsoDate, isoDate, shiftWindow } from '../domain/time.js';
import { DAY_12, NIGHT_12 } from '../testing/fixtures.js';
import type { DstTransition } from './real-minutes.js';
import {
  minutesInWindow,
  splitMinutes,
  windowBoundaryMinute,
  windowDayOf,
} from './window-split.js';

const SPRING_FORWARD: DstTransition = { atMinute: 29_548_920, deltaMinutes: 60 };
const FALL_BACK: DstTransition = { atMinute: 29_891_640, deltaMinutes: -60 };
const TZ = [SPRING_FORWARD, FALL_BACK];

const night = (date: string) => ({ window: shiftWindow(isoDate(date), NIGHT_12) });
const day = (date: string) => ({ window: shiftWindow(isoDate(date), DAY_12) });
const d = (date: string): IsoDate => isoDate(date);

describe('splitting a shift at the next week’s first midnight', () => {
  it('gives the old week 5 hours and the new week 7 of an ordinary Saturday night', () => {
    // 19:00–24:00 = 300 minutes; 00:00–07:00 = 420.
    expect(splitMinutes(night('2026-01-10'), d('2026-01-11'), TZ)).toEqual([300, 420]);
  });

  it('counts the spring-forward Saturday night as 5 hours before Sunday and 6 after', () => {
    // 19:00–24:00 = 300; Sunday 00:00–07:00 is 420 wall minutes less the skipped 02:00–03:00.
    expect(splitMinutes(night('2026-03-07'), d('2026-03-08'), TZ)).toEqual([300, 360]);
  });

  it('counts the fall-back Saturday night as 5 hours before Sunday and 8 after', () => {
    // 19:00–24:00 = 300; Sunday 00:00–07:00 is 420 wall minutes plus the repeated 01:00–02:00.
    expect(splitMinutes(night('2026-10-31'), d('2026-11-01'), TZ)).toEqual([300, 480]);
  });

  it('keeps a Friday night wholly in its own week', () => {
    expect(splitMinutes(night('2026-01-09'), d('2026-01-11'), TZ)).toEqual([720, 0]);
  });

  it('puts the hours a Saturday night is held over into the new week', () => {
    // Held over 90 minutes: ends Sunday 08:30, so 00:00–08:30 = 510 minutes after the edge.
    const held = { window: { ...night('2026-01-10').window } };
    held.window.endMinute += 90;
    expect(splitMinutes(held, d('2026-01-11'), TZ)).toEqual([300, 510]);
  });
});

describe('the minutes a shift works inside one week', () => {
  it('gives the new week only the Sunday hours of the night before it', () => {
    // Week of Sun 11 Jan to Sat 17 Jan: the Saturday-10 night's 00:00–07:00 Sunday part.
    expect(minutesInWindow(night('2026-01-10'), d('2026-01-11'), d('2026-01-18'), TZ)).toBe(420);
  });

  it('counts a Wednesday day shift whole', () => {
    expect(minutesInWindow(day('2026-01-14'), d('2026-01-11'), d('2026-01-18'), TZ)).toBe(720);
  });

  it('counts nothing of a shift that ends before the week starts', () => {
    expect(minutesInWindow(night('2026-01-09'), d('2026-01-11'), d('2026-01-18'), TZ)).toBe(0);
  });
});

describe('a work week that starts at a shift change', () => {
  // Saturday 19:00 is minute 1140 of Saturday; Sunday 07:00 is minute 420 of Sunday.
  it('puts a Saturday 19:00 night wholly in the week that starts at Saturday 19:00', () => {
    // The boundary is the night's own start: nothing before it, all 720 minutes after.
    expect(splitMinutes(night('2026-01-10'), d('2026-01-10'), TZ, 1140)).toEqual([0, 720]);
  });

  it('puts a Saturday 19:00 night wholly in the week that ends at Sunday 07:00', () => {
    // 19:00 Saturday to 07:00 Sunday ends exactly on the boundary: all 720 minutes before it.
    expect(splitMinutes(night('2026-01-10'), d('2026-01-11'), TZ, 420)).toEqual([720, 0]);
  });

  it('reads the boundary of the window dated Saturday as 19:00 that Saturday', () => {
    // 2026-01-10 is day 20463 of the timeline: 20463 × 1440 + 1140.
    expect(windowBoundaryMinute(d('2026-01-10'), 1140)).toBe(20_463 * 1440 + 1140);
    expect(windowBoundaryMinute(d('2026-01-10'))).toBe(20_463 * 1440);
  });

  it('files a Saturday morning before a 19:00 boundary under the day before', () => {
    // Saturday 07:00 is before Saturday 19:00, so its window-day began Friday 19:00.
    expect(windowDayOf(day('2026-01-10').window.startMinute, 1140)).toBe('2026-01-09');
    expect(windowDayOf(night('2026-01-10').window.startMinute, 1140)).toBe('2026-01-10');
    // At minute 0 the window-day is the shift's own date.
    expect(windowDayOf(night('2026-01-10').window.startMinute)).toBe('2026-01-10');
  });

  it('splits the fall-back night at a Sunday 01:30 boundary as the clock reads it', () => {
    // Sat 31 Oct 19:00 to Sun 07:00, 13 real hours (780 minutes). The boundary is wall 01:30,
    // inside the repeated hour [01:00, 02:00). `realMinutesIn` counts a wall end inside that
    // hour after the repeat (the second 01:30): 19:00→01:30 is 390 wall minutes + the 30 repeated
    // minutes 01:00→01:30 = 420 real; the rest is 780 − 420 = 360 (wall 01:30→07:00 = 330 + 30
    // of the repeated hour's second pass, 01:30→02:00).
    expect(splitMinutes(night('2026-10-31'), d('2026-11-01'), TZ, 90)).toEqual([420, 360]);
  });
});
