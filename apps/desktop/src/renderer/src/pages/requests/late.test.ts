import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { isLateRequest } from './late.js';

// Local wall-clock instants, the way a request's submittedAt is stamped on this machine.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('requests after the window closed', () => {
  it('counts a request made on the closing day itself as on time, late into the evening', () => {
    expect(isLateRequest(at(2026, 9, 6, 23), isoDate('2026-09-06'))).toBe(false);
  });

  it('flags a request made the morning after', () => {
    expect(isLateRequest(at(2026, 9, 7, 8), isoDate('2026-09-06'))).toBe(true);
  });

  it('flags nothing when the period has no closing date', () => {
    expect(isLateRequest(at(2027, 1, 1), undefined)).toBe(false);
  });
});
