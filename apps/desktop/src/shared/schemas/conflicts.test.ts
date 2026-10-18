import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

const resolution = {
  id: 'r-1',
  conflictId: 'c-1',
  kind: 'assign_available',
  title: 'Assign Priya Nair (RN) - straight time',
  description: 'She is rested and under her hours.',
  actions: [
    {
      type: 'create_assignment',
      nurseId: 'n-1',
      shiftTypeId: 's-1',
      date: '2026-03-02',
      isCharge: false,
      isOvertime: false,
    },
  ],
  impact: {
    coverage: { hardShortfallBefore: 1, hardShortfallAfter: 0, delta: -1 },
    fairness: { unitScoreBefore: 80, unitScoreAfter: 79.5, delta: -0.5, affected: [] },
    cost: { dollarsBefore: 1000, dollarsAfter: 1450, delta: 450, unpriced: false },
    softViolationsIntroduced: [],
    softViolationsCleared: [],
  },
  score: 1234.5,
  nurseIds: ['n-1'],
};

describe('a conflict resolution arriving over IPC', () => {
  const resolve = API_SCHEMAS.conflicts.resolve;

  it('accepts an option id and the reason', () => {
    expect(
      resolve.safeParse([
        'p-1',
        'understaffing:2026-03-02:s-1:RN/assign_available:n-1',
        'Covers the short night',
      ]).success,
    ).toBe(true);
  });

  it('refuses a whole resolution in place of its id', () => {
    expect(resolve.safeParse(['p-1', resolution, 'x']).success).toBe(false);
  });

  it('lets a blank reason reach the audit layer, which refuses it in words', () => {
    expect(resolve.safeParse(['p-1', 'res-1', '']).success).toBe(true);
  });

  it('refuses a policy with a negative cost limit', () => {
    const save = API_SCHEMAS.conflicts.savePolicy;
    const policy = { enabled: true, maxCostDelta: 0, maxFairnessDrop: 1 };
    expect(save.safeParse(['u-1', policy]).success).toBe(true);
    expect(save.safeParse(['u-1', { ...policy, maxCostDelta: -5 }]).success).toBe(false);
  });
});
