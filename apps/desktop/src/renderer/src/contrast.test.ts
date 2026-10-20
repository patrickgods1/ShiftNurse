import { describe, expect, it } from 'vitest';
import { contrastRatio, readableTextColor } from './contrast.js';

describe('chip text on the shift colours the presets ship', () => {
  // Hand computation: amber luminance 0.4389, #1a1f28 luminance 0.0135, so dark text reads
  // (0.4389+0.05)/(0.0135+0.05) = 7.70 and white reads 1.05/0.4889 = 2.15.
  it('puts dark text on amber, where white would be unreadable', () => {
    expect(readableTextColor('#f59e0b')).toBe('#1a1f28');
  });

  it.each([
    ['#10b981', 6.52],
    ['#14b8a6', 6.64],
    ['#94a3b8', 6.45],
    ['#f97316', 5.9],
  ])('puts dark text on %s (%s : 1)', (hex, ratio) => {
    expect(readableTextColor(hex)).toBe('#1a1f28');
    expect(contrastRatio(hex, '#1a1f28')).toBeCloseTo(ratio, 2);
  });

  it('keeps white text on the deep teal day shift', () => {
    expect(readableTextColor('#1f6f8b')).toBe('#ffffff');
  });

  it('falls back to dark text when the colour cannot be read', () => {
    expect(readableTextColor('teal')).toBe('#1a1f28');
  });

  it('measures black on white as 21 to 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});
