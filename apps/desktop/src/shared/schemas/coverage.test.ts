import { describe, expect, it } from 'vitest';
import { coverageSchemas } from './coverage.js';

describe('a coverage floor arriving over IPC', () => {
  const floor = {
    unitId: 'u-1',
    shiftTypeId: 'st-1',
    weekday: 1,
    date: null,
    role: 'RN',
    minCount: 5,
    targetCount: 6,
  };

  it('accepts a Monday floor of five nurses', () => {
    expect(coverageSchemas.upsert.safeParse([floor]).success).toBe(true);
  });

  it('accepts a one-off override for a single date', () => {
    const oneOff = { ...floor, weekday: null, date: '2026-12-25', minCount: 0, targetCount: 0 };
    expect(coverageSchemas.upsert.safeParse([oneOff]).success).toBe(true);
  });

  it('refuses a weekday that does not exist and half a nurse', () => {
    expect(coverageSchemas.upsert.safeParse([{ ...floor, weekday: 7 }]).success).toBe(false);
    expect(coverageSchemas.upsert.safeParse([{ ...floor, minCount: 2.5 }]).success).toBe(false);
  });
});
