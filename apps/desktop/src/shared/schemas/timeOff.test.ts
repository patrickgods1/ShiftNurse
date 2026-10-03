import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a time-off request arriving over IPC', () => {
  const create = API_SCHEMAS.timeOff.create;

  it('accepts a week of paid leave', () => {
    const request = {
      nurseId: 'n-1',
      startDate: '2026-03-02',
      endDate: '2026-03-08',
      type: 'pto',
      reason: 'Family wedding',
      paidHours: 36,
    };
    expect(create.safeParse([request]).success).toBe(true);
  });

  it('refuses negative paid hours and an end date that is not a date', () => {
    const base = { nurseId: 'n-1', startDate: '2026-03-02', endDate: '2026-03-08', type: 'pto' };
    expect(create.safeParse([{ ...base, paidHours: -12 }]).success).toBe(false);
    expect(create.safeParse([{ ...base, endDate: '2026-02-30' }]).success).toBe(false);
    expect(create.safeParse([{ ...base, type: 'vacation' }]).success).toBe(false);
  });

  it('refuses a field the request does not have, rather than dropping it', () => {
    const base = { nurseId: 'n-1', startDate: '2026-03-02', endDate: '2026-03-08', type: 'pto' };
    expect(create.safeParse([{ ...base, status: 'approved' }]).success).toBe(false);
  });

  it('lets a blank denial reach the audit layer, which refuses it in words', () => {
    expect(API_SCHEMAS.timeOff.deny.safeParse(['t-1', '']).success).toBe(true);
    expect(API_SCHEMAS.timeOff.deny.safeParse(['t-1']).success).toBe(false);
  });
});
