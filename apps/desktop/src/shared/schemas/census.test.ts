import { describe, expect, it } from 'vitest';
import { censusSchemas } from './census.js';

describe('a census read arriving over IPC', () => {
  it('refuses a forecast over 1970 to 9999 or looking back a billion weeks', () => {
    const { propose } = censusSchemas;
    expect(propose.safeParse(['u', '1970-01-01', '9999-12-31']).success).toBe(false);
    expect(
      propose.safeParse(['u', '2026-10-04', '2026-11-14', { lookbackWeeks: 1e9 }]).success,
    ).toBe(false);
    expect(propose.safeParse(['u', '2026-10-04', '2026-11-14']).success).toBe(true);
    expect(
      propose.safeParse(['u', '2026-10-04', '2026-11-14', { lookbackWeeks: 12 }]).success,
    ).toBe(true);
  });

  it('refuses a range that ends before it starts', () => {
    for (const method of ['list', 'demand', 'propose'] as const) {
      const result = censusSchemas[method].safeParse(['u', '2026-11-14', '2026-10-04']);
      expect(result.success, method).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('the range ends before it starts');
    }
  });

  it('refuses a census window longer than 400 days with the number in the words', () => {
    const result = censusSchemas.list.safeParse(['u', '2026-01-01', '2028-01-01']);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('the range is longer than 400 days');
  });
});
