import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a float assignment arriving over IPC', () => {
  const { create, update } = API_SCHEMAS.nurseUnits;

  it('accepts a unit with no note and no dates', () => {
    expect(create.safeParse([{ nurseId: 'n-1', unitId: 'u-2' }]).success).toBe(true);
  });

  it('refuses a date that is not one, or a key it does not know', () => {
    expect(
      create.safeParse([{ nurseId: 'n-1', unitId: 'u-2', startDate: '2026-02-31' }]).success,
    ).toBe(false);
    expect(create.safeParse([{ nurseId: 'n-1', unitId: 'u-2', isHome: true }]).success).toBe(false);
  });

  it('clears a field with null but will not move the nurse to another unit', () => {
    expect(update.safeParse(['nu-1', { competency: null, endDate: null }]).success).toBe(true);
    expect(update.safeParse(['nu-1', { unitId: 'u-3' }]).success).toBe(false);
  });
});
