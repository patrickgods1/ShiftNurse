import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a bidding round arriving over IPC', () => {
  const round = {
    unitId: 'u-1',
    name: 'Summer 2026',
    coversStart: '2026-07-01',
    coversEnd: '2026-08-31',
    opensOn: '2026-03-01',
    closesOn: '2026-03-31',
    offPerDay: { RN: 2 },
  };

  it('accepts a round with or without a limit on weeks per nurse', () => {
    const { createRound } = API_SCHEMAS.leaveBidding;
    expect(createRound.safeParse([round]).success).toBe(true);
    expect(createRound.safeParse([{ ...round, maxAwardsPerNurse: 2 }]).success).toBe(true);
  });

  it('refuses part of a person, a negative place count and an unknown role', () => {
    const { createRound } = API_SCHEMAS.leaveBidding;
    expect(createRound.safeParse([{ ...round, offPerDay: { RN: 1.5 } }]).success).toBe(false);
    expect(createRound.safeParse([{ ...round, offPerDay: { RN: -1 } }]).success).toBe(false);
    expect(createRound.safeParse([{ ...round, offPerDay: { Doctor: 1 } }]).success).toBe(false);
  });

  it('accepts an edit that removes the limit with null, and refuses moving the unit', () => {
    const { updateRound } = API_SCHEMAS.leaveBidding;
    expect(updateRound.safeParse(['r-1', { maxAwardsPerNurse: null }]).success).toBe(true);
    expect(updateRound.safeParse(['r-1', { unitId: 'u-2' }]).success).toBe(false);
  });

  it('refuses a bid choice with a fractional rank or a date that is not on the calendar', () => {
    const { submitBid } = API_SCHEMAS.leaveBidding;
    const good = { rank: 1, startDate: '2026-07-06', endDate: '2026-07-10' };
    expect(submitBid.safeParse(['r-1', 'n-1', [good]]).success).toBe(true);
    expect(submitBid.safeParse(['r-1', 'n-1', [{ ...good, rank: 1.5 }]]).success).toBe(false);
    expect(submitBid.safeParse(['r-1', 'n-1', [{ ...good, endDate: '2026-02-31' }]]).success).toBe(
      false,
    );
  });
});
