import { describe, expect, it } from 'vitest';
import { shiftTypesSchemas } from './shiftTypes.js';

describe('a shift type arriving over IPC', () => {
  const night = {
    unitId: 'u-1',
    name: 'Night 12',
    abbreviation: 'N12',
    startTime: '19:00',
    durationHours: 12,
    isNight: true,
    isOnCall: false,
    withinShiftTypeId: null,
    color: '#1e3a8a',
    sortOrder: 2,
    active: true,
  };

  it('accepts the night shift the settings form sends', () => {
    expect(shiftTypesSchemas.create.safeParse([night]).success).toBe(true);
  });

  it('accepts an 8-hour shift that runs inside the day 12', () => {
    const inside = { ...night, startTime: '07:00', durationHours: 8, withinShiftTypeId: 'st-d12' };
    expect(shiftTypesSchemas.create.safeParse([inside]).success).toBe(true);
  });

  it('refuses a start time that is not a clock time and a shift of zero hours', () => {
    expect(shiftTypesSchemas.create.safeParse([{ ...night, startTime: '7pm' }]).success).toBe(
      false,
    );
    expect(shiftTypesSchemas.create.safeParse([{ ...night, durationHours: 0 }]).success).toBe(
      false,
    );
  });

  it('refuses an edit that tries to move the shift to another unit', () => {
    expect(shiftTypesSchemas.update.safeParse(['st-1', { color: '#fff' }]).success).toBe(true);
    expect(shiftTypesSchemas.update.safeParse(['st-1', { unitId: 'u-2' }]).success).toBe(false);
  });
});
