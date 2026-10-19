import { describe, expect, it } from 'vitest';
import { smokeTimeoutMs } from './smoke-flag.js';

describe('the smoke run time limits', () => {
  it('uses the four-minute default when no limit is set', () => {
    // 4 × 60 × 1000
    expect(smokeTimeoutMs(undefined, 240_000)).toBe(240000);
  });

  it('takes the twenty-minute limit the release workflow sets', () => {
    // 20 × 60 × 1000, release.yml's SHIFTNURSE_SMOKE_TIMEOUT_MS
    expect(smokeTimeoutMs('1200000', 240_000)).toBe(1200000);
  });

  it('ignores a limit written in words instead of killing the app at once', () => {
    expect(smokeTimeoutMs('4min', 240_000)).toBe(240000);
  });

  it('ignores a zero, negative or blank limit', () => {
    expect(smokeTimeoutMs('0', 90_000)).toBe(90000);
    expect(smokeTimeoutMs('-5', 90_000)).toBe(90000);
    expect(smokeTimeoutMs('', 90_000)).toBe(90000);
  });

  it('reads exponent notation as milliseconds', () => {
    // 1.5 × 10⁶
    expect(smokeTimeoutMs('1.5e6', 240_000)).toBe(1500000);
  });
});
