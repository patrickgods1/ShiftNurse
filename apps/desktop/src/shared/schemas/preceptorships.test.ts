import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('an orientation arriving over IPC', () => {
  const orientation = {
    unitId: 'u-1',
    orienteeId: 'n-1',
    preceptorIds: ['n-2', 'n-3'],
    startDate: '2026-10-05',
    endDate: '2026-11-15',
  };

  it('accepts an orientee with two preceptors', () => {
    expect(API_SCHEMAS.preceptorships.create.safeParse([orientation]).success).toBe(true);
  });

  it('refuses an orientation with no preceptor, or a date that is not one', () => {
    const { create } = API_SCHEMAS.preceptorships;
    expect(create.safeParse([{ ...orientation, preceptorIds: [] }]).success).toBe(false);
    expect(create.safeParse([{ ...orientation, endDate: '2026-02-31' }]).success).toBe(false);
  });

  it('refuses an edit that tries to re-pair the nurses', () => {
    const { update } = API_SCHEMAS.preceptorships;
    expect(update.safeParse(['p-1', { endDate: '2026-12-01' }]).success).toBe(true);
    expect(update.safeParse(['p-1', { preceptorId: 'n-9' }]).success).toBe(false);
  });
});
