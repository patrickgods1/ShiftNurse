import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a kept-apart group arriving over IPC', () => {
  const group = { unitId: 'u-1', name: 'Nights pair', nurseIds: ['n-1', 'n-2'], maxTogether: 1 };

  it('accepts a new group with no dates and a reason', () => {
    expect(API_SCHEMAS.incompatibility.create.safeParse([group, 'HR request']).success).toBe(true);
  });

  it('accepts an edit that clears the end date with null', () => {
    const update = API_SCHEMAS.incompatibility.update;
    expect(update.safeParse(['g-1', { endsOn: null }, 'Resolved']).success).toBe(true);
  });

  it('refuses a cap of zero and a missing reason', () => {
    const create = API_SCHEMAS.incompatibility.create;
    expect(create.safeParse([{ ...group, maxTogether: 0 }, 'why']).success).toBe(false);
    expect(create.safeParse([group]).success).toBe(false);
  });
});
