import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a shift exchange arriving over IPC', () => {
  const giveaway = {
    kind: 'giveaway',
    requestingNurseId: 'n-1',
    counterpartyNurseId: 'n-2',
    offeredAssignmentId: 'a-1',
  };

  it('accepts a giveaway with no shift asked back, and a trade with one', () => {
    expect(API_SCHEMAS.exchange.evaluate.safeParse(['p-1', giveaway]).success).toBe(true);
    const trade = { ...giveaway, kind: 'trade', requestedAssignmentId: 'a-2' };
    expect(
      API_SCHEMAS.exchange.propose.safeParse(['p-1', trade, 'swap for a wedding']).success,
    ).toBe(true);
  });

  it('refuses an unknown kind and a stray key', () => {
    const evaluate = API_SCHEMAS.exchange.evaluate;
    expect(evaluate.safeParse(['p-1', { ...giveaway, kind: 'sale' }]).success).toBe(false);
    expect(evaluate.safeParse(['p-1', { ...giveaway, verdict: 'ok' }]).success).toBe(false);
  });

  it('lets a blank denial reach the audit layer, which refuses it in words', () => {
    expect(API_SCHEMAS.exchange.deny.safeParse(['s-1', '']).success).toBe(true);
    expect(API_SCHEMAS.exchange.list.safeParse(['u-1', 'applied']).success).toBe(false);
  });
});
