import { describe, expect, it } from 'vitest';
import { formatTimeOfDay, isoDate, shiftWindow } from '../domain/time.js';
import { DAY_12, EVENING_8, MID_8, NIGHT_8, NIGHT_12, ON_CALL } from '../testing/fixtures.js';
import { floorSegments, overlappingShifts } from './overlap.js';

const WED = isoDate('2026-01-07');

function label(s: { date: string; shiftType: { abbreviation: string } }): string {
  return `${s.shiftType.abbreviation} ${s.date}`;
}

describe('who is on the floor at the same time', () => {
  it('has the 15:00 evening overlapping both the day 12 and the night 12 that follows it', () => {
    const found = overlappingShifts(WED, EVENING_8, [DAY_12, NIGHT_12, EVENING_8]).map(label);
    expect(found).toEqual(['D12 2026-01-07', 'N12 2026-01-07']);
  });

  it('does not treat a night ending at 07:00 as overlapping the day shift starting at 07:00', () => {
    const found = overlappingShifts(WED, DAY_12, [DAY_12, NIGHT_12]).map(label);
    expect(found).toEqual([]);
  });

  it('finds the 23:00 night 8 of the evening before overlapping the night 12 it runs inside', () => {
    // N12 on Wednesday runs 19:00 Wed → 07:00 Thu; N8 dated Wednesday runs 23:00 → 07:00.
    const found = overlappingShifts(WED, NIGHT_12, [NIGHT_12, NIGHT_8]).map(label);
    expect(found).toEqual(['N8 2026-01-07']);
  });

  it('counts a mid shift inside the day 12 as overlapping it', () => {
    expect(overlappingShifts(WED, MID_8, [DAY_12, MID_8]).map(label)).toEqual(['D12 2026-01-07']);
  });

  it('leaves on-call standby off the floor', () => {
    expect(overlappingShifts(WED, NIGHT_12, [NIGHT_12, ON_CALL]).map(label)).toEqual([]);
  });
});

describe('cutting the floor into stretches with the same people on it', () => {
  const day = { name: 'A', window: shiftWindow(WED, DAY_12) }; // 07:00–19:00
  const lateMid = {
    name: 'B',
    window: shiftWindow(WED, { startTime: '11:00', durationHours: 12 }), // 11:00–23:00
  };

  function show(segments: ReturnType<typeof floorSegments<typeof day>>): string[] {
    return segments.map(
      (s) =>
        `${formatTimeOfDay(s.startMinute)}-${formatTimeOfDay(s.endMinute)} ${s.on.map((x) => x.name).join('')}`,
    );
  }

  it('splits a day 12 and an 11:00–23:00 shift into who is on when', () => {
    expect(show(floorSegments([day, lateMid], [day.window, lateMid.window]))).toEqual([
      '07:00-11:00 A',
      '11:00-19:00 AB',
      '19:00-23:00 B',
    ]);
  });

  it('keeps only the stretches inside the hours being judged', () => {
    expect(show(floorSegments([day, lateMid], [day.window]))).toEqual([
      '07:00-11:00 A',
      '11:00-19:00 AB',
    ]);
  });

  it('skips hours nobody is on', () => {
    const night = { name: 'N', window: shiftWindow(WED, NIGHT_12) }; // 19:00–07:00
    const nextDay = { name: 'D', window: shiftWindow(isoDate('2026-01-08'), DAY_12) };
    const within = [day.window, night.window, nextDay.window];
    expect(show(floorSegments([day, nextDay], within))).toEqual(['07:00-19:00 A', '07:00-19:00 D']);
  });
});
