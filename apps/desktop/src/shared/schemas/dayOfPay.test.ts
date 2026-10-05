import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a day-of pay entry arriving over IPC', () => {
  const { record, update } = API_SCHEMAS.dayOfPay;
  const where = { unitId: 'u-1', nurseId: 'n-1', date: '2026-10-06' };

  it('accepts a missed meal break, a send-home and a call-back', () => {
    expect(record.safeParse([{ kind: 'missed_break', ...where, break: 'meal' }]).success).toBe(
      true,
    );
    expect(record.safeParse([{ kind: 'sent_home', ...where, scheduledHours: 12 }]).success).toBe(
      true,
    );
    expect(record.safeParse([{ kind: 'call_back', ...where, hoursWorked: 2 }]).success).toBe(true);
  });

  it('refuses a break that is neither meal nor rest, and hours a call-back must carry', () => {
    expect(record.safeParse([{ kind: 'missed_break', ...where, break: 'nap' }]).success).toBe(
      false,
    );
    expect(record.safeParse([{ kind: 'call_back', ...where }]).success).toBe(false);
  });

  it('refuses hours on a missed break, and an edit that tries to move the day', () => {
    expect(
      record.safeParse([{ kind: 'missed_break', ...where, break: 'rest', hoursWorked: 1 }]).success,
    ).toBe(false);
    expect(update.safeParse(['d-1', { hoursWorked: 3, note: null }]).success).toBe(true);
    expect(update.safeParse(['d-1', { date: '2026-10-07' }]).success).toBe(false);
  });
});
