import { describe, expect, it } from 'vitest';
import { callBackStartMinute, nearestQuarterHour } from './call-back-time.js';

describe('turning the time a nurse was called back into minutes into her standby', () => {
  it('counts a 2 am call-back on a 7 pm standby as seven hours in', () => {
    expect(callBackStartMinute('19:00', '02:00')).toBe(420);
  });

  it('counts a call-back at the moment standby began as zero', () => {
    expect(callBackStartMinute('19:00', '19:00')).toBe(0);
  });

  it('reads a time a minute before the standby as the next evening, which the server refuses', () => {
    expect(callBackStartMinute('19:00', '18:59')).toBe(1439);
  });

  it('counts a late-evening call-back on the same day', () => {
    expect(callBackStartMinute('19:00', '23:30')).toBe(270);
  });
});

describe('the time offered when the call-back form opens', () => {
  it('rounds to the nearest quarter hour', () => {
    expect(nearestQuarterHour(new Date(2026, 9, 5, 2, 7))).toBe('02:00');
    expect(nearestQuarterHour(new Date(2026, 9, 5, 2, 8))).toBe('02:15');
  });

  it('wraps just before midnight to 00:00', () => {
    expect(nearestQuarterHour(new Date(2026, 9, 5, 23, 58))).toBe('00:00');
  });
});
