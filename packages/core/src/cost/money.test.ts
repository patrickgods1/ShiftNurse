import { describe, expect, it } from 'vitest';

import { roundCents, sumCents } from './money.js';

describe('rounding pay to the cent', () => {
  it('rounds a cent and a half up, as a payslip does', () => {
    // 1.005 × 100 is 100.49999999999999 in binary; to six places it is 100.500000, which rounds
    // half up to 101 cents.
    expect(roundCents(1.005)).toBe(1.01);
  });

  it('rounds the 778.207(b) premium to 213.33', () => {
    // 2560 / 48 = 53.3333…; × 8 × 0.5 = 213.3333… → $213.33.
    expect(roundCents(8 * 0.5 * (2560 / 48))).toBe(213.33);
  });

  it('turns float dust into zero', () => {
    expect(roundCents(1.7763568394002505e-13)).toBe(0);
  });

  it('adds three ten-cent lines to exactly thirty cents', () => {
    // 10 + 10 + 10 = 30 cents; a float sum gives 0.30000000000000004.
    expect(sumCents([0.1, 0.1, 0.1])).toBe(0.3);
  });
});
