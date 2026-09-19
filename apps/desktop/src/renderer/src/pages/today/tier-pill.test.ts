import { describe, expect, it } from 'vitest';
import { payTierLabel, payTierTone } from './tier-pill.js';

describe('replacement pay-tier display', () => {
  it('names the contract priority in plain English', () => {
    expect(payTierLabel('straight')).toBe('Straight time');
    expect(payTierLabel('overtime')).toBe('Overtime');
    expect(payTierLabel('agency')).toBe('Agency');
  });

  it('colours agency as the worst outcome and straight time as the best', () => {
    expect(payTierTone('straight')).toBe('success');
    expect(payTierTone('overtime')).toBe('warn');
    expect(payTierTone('agency')).toBe('danger');
  });
});
