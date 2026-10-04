import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('an overtime offer arriving over IPC', () => {
  const offer = {
    unitId: 'u-1',
    nurseId: 'n-1',
    startDate: '2026-10-05',
    endDate: '2026-10-11',
  };

  it('accepts an offer with or without a note', () => {
    const create = API_SCHEMAS.overtimeVolunteers.create;
    expect(create.safeParse([offer]).success).toBe(true);
    expect(create.safeParse([{ ...offer, note: 'texted Oct 3' }]).success).toBe(true);
  });

  it('accepts an edit that clears the note with null', () => {
    expect(API_SCHEMAS.overtimeVolunteers.update.safeParse(['o-1', { note: null }]).success).toBe(
      true,
    );
  });

  it('refuses an edit that tries to move the offer to another nurse, and a bad date', () => {
    const { update, create } = API_SCHEMAS.overtimeVolunteers;
    expect(update.safeParse(['o-1', { nurseId: 'n-2' }]).success).toBe(false);
    expect(create.safeParse([{ ...offer, endDate: '2026-02-31' }]).success).toBe(false);
  });
});
