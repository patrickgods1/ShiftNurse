import { isoDate, type TimeOffRequest, weekdayOf } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { bucketByDay, describeDay, weeksOf } from './heatmap-data.js';

function req(id: string, start: string, end: string, status: TimeOffRequest['status']) {
  return {
    id,
    nurseId: `n_${id}`,
    startDate: isoDate(start),
    endDate: isoDate(end),
    type: 'pto',
    status,
    enteredBy: 'manager',
    submittedAt: 0,
  } as TimeOffRequest;
}

describe('bucketByDay', () => {
  it('counts a Friday-to-Sunday request on all three days, inclusive', () => {
    const days = bucketByDay(
      [req('a', '2026-09-18', '2026-09-20', 'approved')],
      isoDate('2026-09-14'),
      isoDate('2026-09-27'),
    );
    const touched = days.filter((d) => d.approved > 0).map((d) => d.date);
    expect(touched).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  it('separates approved from pending on the same Saturday and ignores a denied one', () => {
    const days = bucketByDay(
      [
        req('a', '2026-09-19', '2026-09-19', 'approved'),
        req('b', '2026-09-19', '2026-09-19', 'approved'),
        req('c', '2026-09-19', '2026-09-20', 'pending'),
        req('d', '2026-09-19', '2026-09-19', 'denied'),
      ],
      isoDate('2026-09-19'),
      isoDate('2026-09-20'),
    );
    expect(days[0]).toMatchObject({ approved: 2, pending: 1, requestIds: ['a', 'b', 'c'] });
    expect(days[1]).toMatchObject({ approved: 0, pending: 1, requestIds: ['c'] });
    expect(describeDay(days[0]!)).toBe('2 approved, 1 pending');
    expect(
      describeDay({ date: isoDate('2026-09-21'), approved: 0, pending: 0, requestIds: [] }),
    ).toBe('no requests');
  });

  it('clips a request that starts before the window and ends after it', () => {
    const days = bucketByDay(
      [req('long', '2026-08-01', '2026-10-31', 'pending')],
      isoDate('2026-09-01'),
      isoDate('2026-09-03'),
    );
    expect(days).toHaveLength(3);
    expect(days.every((d) => d.pending === 1)).toBe(true);
  });
});

describe('weeksOf', () => {
  it('pads a period that starts on a Tuesday so Sunday is always the first column', () => {
    // 2026-09-15 is a Tuesday.
    const days = bucketByDay([], isoDate('2026-09-15'), isoDate('2026-09-28'));
    const weeks = weeksOf(days, weekdayOf);
    expect(weeks).toHaveLength(3);
    expect(weeks[0]!.slice(0, 2).map((c) => c.date)).toEqual(['2026-09-13', '2026-09-14']);
    expect(weeks[0]![0]?.day).toBeUndefined();
    expect(weeks[0]![2]?.day?.date).toBe('2026-09-15');
    expect(weeks[2]!.filter((c) => c.day !== undefined)).toHaveLength(2);
    expect(weeks[2]![6]?.date).toBe('2026-10-03');
  });
});
