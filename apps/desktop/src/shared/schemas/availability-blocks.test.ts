import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('an accommodation arriving over IPC', () => {
  const block = {
    unitId: 'u-1',
    nurseId: 'n-1',
    weekdays: [5],
    startTime: '18:00',
    endTime: '18:00',
    reason: 'Keeps the Sabbath',
  };
  const { create, update } = API_SCHEMAS.availabilityBlocks;

  it('accepts a recurring window with its reason', () => {
    expect(create.safeParse([block]).success).toBe(true);
    expect(
      create.safeParse([{ ...block, startsOn: '2026-10-01', endsOn: '2026-12-31' }]).success,
    ).toBe(true);
  });

  it('refuses a weekday that does not exist, a time that is not one and a field it does not know', () => {
    expect(create.safeParse([{ ...block, weekdays: [7] }]).success).toBe(false);
    expect(create.safeParse([{ ...block, startTime: '6pm' }]).success).toBe(false);
    expect(create.safeParse([{ ...block, extra: 1 }]).success).toBe(false);
  });

  it('will not let an update move the block to another nurse', () => {
    expect(update.safeParse(['ablk-1', { nurseId: 'n-2' }, 'why']).success).toBe(false);
    expect(update.safeParse(['ablk-1', { endsOn: null }, 'Ongoing now']).success).toBe(true);
  });
});
