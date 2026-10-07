import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a rest waiver arriving over IPC', () => {
  const waiver = { unitId: 'u-1', nurseId: 'n-1', date: '2026-10-06', reason: 'Signed waiver' };

  it('accepts a waiver with its reason', () => {
    expect(API_SCHEMAS.restWaivers.create.safeParse([waiver]).success).toBe(true);
  });

  it('refuses a date that is not one and a field it does not know', () => {
    const { create } = API_SCHEMAS.restWaivers;
    expect(create.safeParse([{ ...waiver, date: '2026-02-31' }]).success).toBe(false);
    expect(create.safeParse([{ ...waiver, extra: 1 }]).success).toBe(false);
  });

  it('lets a blank reason reach the audit layer, which refuses it in words', () => {
    expect(API_SCHEMAS.restWaivers.create.safeParse([{ ...waiver, reason: '' }]).success).toBe(
      true,
    );
    expect(API_SCHEMAS.restWaivers.remove.safeParse(['rwv-1', '']).success).toBe(true);
  });
});
