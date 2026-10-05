import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a call-off arriving over IPC', () => {
  it('accepts a sick call with the shift paid from sick leave', () => {
    expect(API_SCHEMAS.dayOf.reportCallOff.safeParse(['a-1', 'Flu', 12]).success).toBe(true);
    expect(API_SCHEMAS.dayOf.reportCallOff.safeParse(['a-1']).success).toBe(true);
  });

  it('refuses negative sick hours', () => {
    expect(API_SCHEMAS.dayOf.reportCallOff.safeParse(['a-1', 'Flu', -12]).success).toBe(false);
  });

  it('refuses logging an accepted call, which is a backfill', () => {
    const logCall = API_SCHEMAS.dayOf.logCall;
    expect(logCall.safeParse(['c-1', 'n-2', 'no_answer', 'rang twice']).success).toBe(true);
    expect(logCall.safeParse(['c-1', 'n-2', 'accepted']).success).toBe(false);
  });

  it('refuses a range that is not dates, and lets a blank reason reach the audit layer', () => {
    expect(API_SCHEMAS.dayOf.callOffs.safeParse(['u-1', '2026-03-01', 'soon']).success).toBe(false);
    expect(API_SCHEMAS.dayOf.markUncovered.safeParse(['c-1', '']).success).toBe(true);
  });
});

describe('sending a nurse home for low census over IPC', () => {
  it('accepts a cancellation naming the shift, the role and who volunteered', () => {
    const args = ['p-1', '2026-10-05', 'st-d', 'RN', ['n-2'], 'n-2'];
    expect(API_SCHEMAS.dayOf.cancelForCensus.safeParse(args).success).toBe(true);
  });

  it('refuses a made-up role, and a tier the order does not know', () => {
    const args = ['p-1', '2026-10-05', 'st-d', 'Doctor', [], 'n-2'];
    expect(API_SCHEMAS.dayOf.cancelForCensus.safeParse(args).success).toBe(false);
    expect(API_SCHEMAS.dayOf.saveCancellationPolicy.safeParse(['u-1', ['seniority']]).success).toBe(
      false,
    );
  });
});
