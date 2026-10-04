import { describe, expect, it } from 'vitest';
import { acuitySchemas } from './acuity.js';

describe('acuity settings arriving over IPC', () => {
  it('accepts a ratio rule the way the form sends it, citation left out', () => {
    const input = {
      unitId: 'u-1',
      role: 'RN',
      acuityTierId: null,
      maxPatientsPerNurse: 5,
      citation: undefined,
      active: true,
    };
    expect(acuitySchemas.createRatioRule.safeParse([input]).success).toBe(true);
  });

  it('lets an edit clear a ratio rule citation', () => {
    expect(acuitySchemas.updateRatioRule.safeParse(['r-1', { citation: null }]).success).toBe(true);
  });

  it('refuses a ratio of zero patients per nurse', () => {
    expect(
      acuitySchemas.updateRatioRule.safeParse(['r-1', { maxPatientsPerNurse: 0 }]).success,
    ).toBe(false);
  });

  it('refuses an HPPD target that is not a number', () => {
    expect(acuitySchemas.setHppd.safeParse(['u-1', 8.5]).success).toBe(true);
    expect(acuitySchemas.setHppd.safeParse(['u-1', Number.NaN]).success).toBe(false);
  });

  it('refuses a tier edit that tries to move it to another unit', () => {
    expect(acuitySchemas.updateTier.safeParse(['t-1', { level: 2 }]).success).toBe(true);
    expect(acuitySchemas.updateTier.safeParse(['t-1', { unitId: 'u-2' }]).success).toBe(false);
  });
});
