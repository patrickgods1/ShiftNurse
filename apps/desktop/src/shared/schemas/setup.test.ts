import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('first-run setup arriving over IPC', () => {
  it('accepts the unit the welcome screen creates', () => {
    const unit = {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: '2026-01-04',
    };
    expect(API_SCHEMAS.setup.createUnit.safeParse([unit, 'assisted']).success).toBe(true);
    expect(API_SCHEMAS.setup.createUnit.safeParse([unit, 'demo']).success).toBe(false);
  });

  it('accepts a coverage preset and refuses a step that is not in the guide', () => {
    const preset = { kind: 'coverage', shiftTypeIds: ['st-1'], counts: { RN: 4, CNA: 1 } };
    expect(API_SCHEMAS.setup.applyPreset.safeParse(['u-1', preset]).success).toBe(true);
    const move = { from: 'roster', to: 'lunch', skipped: false };
    expect(API_SCHEMAS.setup.advance.safeParse([move]).success).toBe(false);
  });

  it('refuses a base rate that is negative', () => {
    const preset = { kind: 'base-rates', rates: { RN: -5 } };
    expect(API_SCHEMAS.setup.applyPreset.safeParse(['u-1', preset]).success).toBe(false);
  });
});
