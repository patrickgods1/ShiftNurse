import { describe, expect, it } from 'vitest';
import { typicalShiftHours } from './paid-hours.js';

const st = (durationHours: number, over: { active?: boolean; isOnCall?: boolean } = {}) => ({
  durationHours,
  active: true,
  isOnCall: false,
  ...over,
});

describe('typicalShiftHours', () => {
  it('uses the shift length most of the unit works', () => {
    expect(typicalShiftHours([st(8), st(8), st(8), st(12)])).toBe(8);
  });

  it('prefers the longer shift when a unit runs as many of each', () => {
    expect(typicalShiftHours([st(12), st(12), st(8), st(8)])).toBe(12);
  });

  it('ignores on-call and retired shift types', () => {
    expect(typicalShiftHours([st(12), st(24, { isOnCall: true }), st(24, { active: false })])).toBe(
      12,
    );
  });

  it('falls back to 8 hours on a unit with no shifts yet', () => {
    expect(typicalShiftHours([])).toBe(8);
  });
});
