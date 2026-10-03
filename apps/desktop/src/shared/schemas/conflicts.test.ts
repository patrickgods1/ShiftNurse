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

  it('accepts a resolution the analysis produced, with its reason', () => {
    expect(resolve.safeParse(['p-1', resolution, 'Covers the short night']).success).toBe(true);
  });

  it('lets a blank reason reach the audit layer, which refuses it in words', () => {
    expect(resolve.safeParse(['p-1', resolution, '']).success).toBe(true);
  });

  it('refuses an action on a date that does not exist and a stray key', () => {
    const badDate = {
      ...resolution,
      actions: [
        { type: 'move_assignment', assignmentId: 'a-1', toDate: '2026-02-30', toShiftTypeId: 's' },
      ],
    };
    expect(resolve.safeParse(['p-1', badDate, 'x']).success).toBe(false);
    expect(resolve.safeParse(['p-1', { ...resolution, approved: true }, 'x']).success).toBe(false);
  });

  it('refuses a policy with a negative cost limit', () => {
    const save = API_SCHEMAS.conflicts.savePolicy;
    const policy = { enabled: true, maxCostDelta: 0, maxFairnessDrop: 1 };
    expect(save.safeParse(['u-1', policy]).success).toBe(true);
    expect(save.safeParse(['u-1', { ...policy, maxCostDelta: -5 }]).success).toBe(false);
  });
});
