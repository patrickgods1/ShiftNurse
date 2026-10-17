import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { historyCompleteFrom } from './history.js';

const published = (startDate: string, endDate: string) => ({
  startDate: isoDate(startDate),
  endDate: isoDate(endDate),
});

describe('how far back the published schedules reach', () => {
  it('reaches back through two published schedules to the edge of the tail', () => {
    // Floor = Jan 11 − 28 = Dec 14. Jan 10 is in Dec 28–Jan 10 → Dec 28; Dec 27 is in
    // Dec 14–27 → Dec 14; Dec 13 is before the floor, so stop at Dec 14.
    const history = [published('2025-12-14', '2025-12-27'), published('2025-12-28', '2026-01-10')];
    expect(historyCompleteFrom(history, isoDate('2026-01-11'), 28)).toBe('2025-12-14');
  });

  it('stops at a gap: nothing published the day before means no history', () => {
    // Jan 10 is in no published schedule, so nothing before Jan 11 is on record.
    const history = [published('2025-12-14', '2025-12-27')];
    expect(historyCompleteFrom(history, isoDate('2026-01-11'), 28)).toBe('2026-01-11');
  });

  it('never reaches past the tail even when a published schedule does', () => {
    // Floor = Dec 14; Jan 10 is in Dec 1–Jan 10, whose start is before the floor → Dec 14.
    const history = [published('2025-12-01', '2026-01-10')];
    expect(historyCompleteFrom(history, isoDate('2026-01-11'), 28)).toBe('2025-12-14');
  });
});
