/**
 * The demo history counts a nurse's weekly hours in the week the unit's rule set judges, so a
 * week that starts at the Saturday 19:00 shift change is counted from there. Hand-counted:
 * 2026-01-10 is a Saturday; history periods start on Sundays, so the week from Sat 10 Jan 19:00
 * straddles the period ending that Saturday and the one starting Sun 11 Jan.
 */

import { isoDate, type ShiftType } from '@shiftnurse/core';
import { DAY_12, NIGHT_12 } from '@shiftnurse/core/testing';
import { describe, expect, it } from 'vitest';
import { hoursBefore, hoursInWeek, type Staff, type Worked, type WorkWeek } from './engine.js';

const SAT_19: WorkWeek = { startsOn: 6, startMinute: 1140 };

function nurseWorking(id: string, shifts: Record<string, ShiftType>): [Staff, Worked] {
  const staff = { nurse: { id } } as Staff;
  const worked: Worked = new Map([
    [id, new Map(Object.entries(shifts).map(([d, t]) => [isoDate(d), t]))],
  ]);
  return [staff, worked];
}

describe('demo history under a week that starts at Saturday 19:00', () => {
  const tuesday = isoDate('2026-01-13');
  const periodStart = isoDate('2026-01-11');

  it('carries last period’s Saturday night into the week a Tuesday 12 is counted in', () => {
    // Sat 10 Jan 19:00 night starts on the boundary: the week from 10 Jan holds it and Mon 12 Jan,
    // 24h; 12 of them were worked before the period starting Sun 11 Jan.
    const [staff, worked] = nurseWorking('a', { '2026-01-10': NIGHT_12, '2026-01-12': DAY_12 });
    expect(hoursInWeek(worked, staff, tuesday, DAY_12, SAT_19)).toBe(24);
    expect(hoursBefore(worked, staff, tuesday, DAY_12, SAT_19, periodStart)).toBe(12);
  });

  it('leaves a Saturday day shift in the week before, which ends at 19:00 that evening', () => {
    // Sat 10 Jan 07:00 starts before the boundary, so the week from 10 Jan holds only Mon 12 Jan.
    const [staff, worked] = nurseWorking('b', { '2026-01-10': DAY_12, '2026-01-12': DAY_12 });
    expect(hoursInWeek(worked, staff, tuesday, DAY_12, SAT_19)).toBe(12);
    expect(hoursBefore(worked, staff, tuesday, DAY_12, SAT_19, periodStart)).toBe(0);
  });
});
