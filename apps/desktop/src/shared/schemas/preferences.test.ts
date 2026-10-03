import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a nurse preference list arriving over IPC', () => {
  const replace = API_SCHEMAS.preferences.replace;

  it('accepts one preference of each kind at the editor defaults', () => {
    const list = [
      { kind: 'avoid_shift_type', shiftTypeId: 'st-1', weight: 3 },
      { kind: 'prefer_weekday', weekday: 0, weight: 3 },
      { kind: 'weekend_appetite', level: 0, weight: 3 },
      { kind: 'preferred_block_length', shifts: 3, weight: 3 },
    ];
    expect(replace.safeParse(['n-1', list]).success).toBe(true);
  });

  it('refuses a weekday that is not in the week', () => {
    expect(
      replace.safeParse(['n-1', [{ kind: 'avoid_weekday', weekday: 7, weight: 3 }]]).success,
    ).toBe(false);
  });

  it('refuses a payload that belongs to a different kind', () => {
    const bad = [{ kind: 'weekend_appetite', shiftTypeId: 'st-1', weight: 3 }];
    expect(replace.safeParse(['n-1', bad]).success).toBe(false);
  });
});
