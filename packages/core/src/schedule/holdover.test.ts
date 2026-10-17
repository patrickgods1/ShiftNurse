import { describe, expect, it } from 'vitest';
import type { Assignment } from '../domain/entities.js';
import { dayNumber, isoDate } from '../domain/time.js';
import { holdoverHours, workedHours, workedStretches, workedWindow } from './holdover.js';
import { ScheduleView } from './view.js';

const DAY12 = { startTime: '07:00', durationHours: 12 };
const NIGHT12 = { startTime: '19:00', durationHours: 12 };

function row(date: string, shiftTypeId: string, extra: Partial<Assignment> = {}): Assignment {
  return {
    id: `${date}-${shiftTypeId}`,
    periodId: 'p1',
    nurseId: 'n1',
    shiftTypeId,
    date: isoDate(date),
    source: 'manual',
    isLocked: false,
    isCharge: false,
    isOvertime: false,
    ...extra,
  };
}

describe('holdovers', () => {
  it('counts a day shift held over 90 minutes as 13.5 hours worked', () => {
    expect(workedHours({ holdoverMinutes: 90 }, DAY12)).toBe(13.5);
    expect(holdoverHours({ holdoverMinutes: 90 })).toBe(1.5);
  });

  it('counts a shift with no holdover recorded as its scheduled length', () => {
    expect(workedHours({}, DAY12)).toBe(12);
    expect(holdoverHours({ holdoverMinutes: 0 })).toBe(0);
  });

  it('ends a 07:00 day shift held over 90 minutes at 20:30 the same day', () => {
    const w = workedWindow(isoDate('2026-03-02'), DAY12, { holdoverMinutes: 90 });
    const midnight = dayNumber(isoDate('2026-03-02')) * 1440;
    expect(w.startMinute).toBe(midnight + 7 * 60);
    expect(w.endMinute).toBe(midnight + 20 * 60 + 30);
  });

  it('ends a Friday night shift held over two hours at 09:00 Saturday', () => {
    const w = workedWindow(isoDate('2026-03-06'), NIGHT12, { holdoverMinutes: 120 });
    expect(w.endMinute).toBe(dayNumber(isoDate('2026-03-07')) * 1440 + 9 * 60);
  });

  it('gives the read model the worked hours and window, and keeps the scheduled hours', () => {
    const view = new ScheduleView({
      period: {
        id: 'p1',
        unitId: 'u1',
        name: 'March',
        startDate: '2026-03-01',
        endDate: '2026-03-14',
        status: 'published',
      } as never,
      assignments: [row('2026-03-02', 'D12', { holdoverMinutes: 90, holdoverMandated: true })],
      nurses: [{ id: 'n1' } as never],
      shiftTypes: [{ id: 'D12', ...DAY12 } as never],
    });
    const v = view.assignments()[0]!;
    expect(v.paidHours).toBe(13.5);
    expect(v.scheduledHours).toBe(12);
    expect(v.window.endMinute - v.window.startMinute).toBe(13.5 * 60);
  });
});

describe('worked stretches', () => {
  const types = new Map([
    ['D8', { startTime: '07:00', durationHours: 8, isOnCall: false }],
    ['E8', { startTime: '15:00', durationHours: 8, isOnCall: false }],
    ['OC', { startTime: '15:00', durationHours: 8, isOnCall: true }],
    ['L9', { startTime: '15:30', durationHours: 9, isOnCall: false }],
    ['L8', { startTime: '16:01', durationHours: 8, isOnCall: false }],
  ]);
  const view = (a: Assignment) => {
    const st = types.get(a.shiftTypeId)!;
    return {
      assignment: a,
      shiftType: st,
      window: workedWindow(a.date, st, a),
      paidHours: workedHours(a, st),
    };
  };

  it('joins a day shift and the evening shift that starts the minute it ends', () => {
    const stretches = workedStretches([
      view(row('2026-03-02', 'D8')),
      view(row('2026-03-02', 'E8', { id: 'e' })),
    ]);
    expect(stretches).toHaveLength(1);
    expect(stretches[0]!.hours).toBe(16);
    expect(stretches[0]!.views).toHaveLength(2);
  });

  it('keeps apart two shifts with an hour between them', () => {
    const stretches = workedStretches([
      view(row('2026-03-02', 'D8', { holdoverMinutes: 0 })),
      view(row('2026-03-03', 'D8')),
    ]);
    expect(stretches.map((s) => s.hours)).toEqual([8, 8]);
  });

  it('joins a day shift held over into the next shift and counts the overlap once', () => {
    // 07:00–15:00 held over 30 min runs to 15:30; the evening shift starts at 15:00. The nurse
    // is on the floor 07:00–23:00: 16 hours, not 16.5.
    const stretches = workedStretches([
      view(row('2026-03-02', 'D8', { holdoverMinutes: 30 })),
      view(row('2026-03-02', 'E8', { id: 'e' })),
    ]);
    expect(stretches[0]!.hours).toBe(16);
  });

  it('leaves on-call standby out of a stretch', () => {
    const stretches = workedStretches([
      view(row('2026-03-02', 'D8')),
      view(row('2026-03-02', 'OC', { id: 'oc' })),
    ]);
    expect(stretches.map((s) => s.hours)).toEqual([8]);
  });

  it('joins two shifts with a 30-minute meal break between them when breaks of an hour bridge', () => {
    // 07:00–15:00, a break to 15:30, then 15:30–00:30: 17.5 hours on the clock, 8 + 9 = 17 worked.
    const stretches = workedStretches(
      [view(row('2026-03-02', 'D8')), view(row('2026-03-02', 'L9', { id: 'l' }))],
      { bridgeMinutes: 60 },
    );
    expect(stretches).toHaveLength(1);
    expect(stretches[0]!.hours).toBe(17);
    expect(stretches[0]!.breakMinutes).toBe(30);
    expect(stretches[0]!.views).toHaveLength(2);
    expect(stretches[0]!.window).toEqual({
      startMinute: dayNumber(isoDate('2026-03-02')) * 1440 + 7 * 60,
      endMinute: dayNumber(isoDate('2026-03-03')) * 1440 + 30,
    });
  });

  it('still ends a stretch at a 61-minute gap', () => {
    // 15:00 to 16:01 is 61 minutes, one more than the hour that bridges.
    const stretches = workedStretches(
      [view(row('2026-03-02', 'D8')), view(row('2026-03-02', 'L8', { id: 'l' }))],
      { bridgeMinutes: 60 },
    );
    expect(stretches.map((s) => s.hours)).toEqual([8, 8]);
  });

  it('leaves stretches unchanged when no bridge is given', () => {
    const stretches = workedStretches([
      view(row('2026-03-02', 'D8')),
      view(row('2026-03-02', 'L9', { id: 'l' })),
    ]);
    expect(stretches.map((s) => s.hours)).toEqual([8, 9]);
    expect(stretches.map((s) => s.breakMinutes)).toEqual([0, 0]);
  });
});
