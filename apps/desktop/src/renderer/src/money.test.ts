import { describe, expect, it } from 'vitest';
import { formatDollars, formatHours, formatSignedDollars } from './money.js';

describe('money formatting', () => {
  it('rounds headline totals to whole dollars and keeps cents on rates', () => {
    expect(formatDollars(1234.56)).toBe('$1,235');
    expect(formatDollars(48.5, { cents: true })).toBe('$48.50');
  });

  it('signs a budget variance so over and under read differently', () => {
    expect(formatSignedDollars(2000)).toBe('+$2,000');
    expect(formatSignedDollars(-300)).toBe('−$300');
    expect(formatSignedDollars(0)).toBe('$0');
  });

  it('a variance under fifty cents reads as no change, without a sign', () => {
    expect(formatSignedDollars(0.4)).toBe('$0');
    expect(formatSignedDollars(-0.4)).toBe('$0');
  });

  it('fifty cents rounds away from zero on both sides', () => {
    expect(formatSignedDollars(0.5)).toBe('+$1');
    expect(formatSignedDollars(-0.5)).toBe('−$1');
  });

  it('keeps the sign on a real variance', () => {
    expect(formatSignedDollars(-300)).toBe('−$300');
    expect(formatSignedDollars(1199.6)).toBe('+$1,200');
  });

  it('prints hours without a spurious decimal', () => {
    expect(formatHours(8)).toBe('8h');
    expect(formatHours(7.25)).toBe('7.3h');
  });
});
