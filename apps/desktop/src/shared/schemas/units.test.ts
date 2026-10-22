/** A unit's policies as Settings › Unit sends them. */

import { describe, expect, it } from 'vitest';
import { unitsSchemas } from './units.js';

describe('unit policies arriving over IPC', () => {
  it('accepts each way of dating a holiday shift, and null to clear it', () => {
    const update = unitsSchemas.update;
    for (const holidayAttribution of ['start', 'clock', 'majority', null]) {
      expect(update.safeParse(['u-1', { holidayAttribution }]).success).toBe(true);
    }
  });

  it('accepts the federal in-lieu rule, none, and null to clear it', () => {
    for (const inLieuHolidays of ['none', 'federal', null]) {
      expect(unitsSchemas.update.safeParse(['u-1', { inLieuHolidays }]).success).toBe(true);
    }
  });

  it('refuses an in-lieu rule it does not know', () => {
    expect(unitsSchemas.update.safeParse(['u-1', { inLieuHolidays: 'state' }]).success).toBe(false);
  });

  it('refuses a way of dating a holiday shift it does not know', () => {
    expect(unitsSchemas.update.safeParse(['u-1', { holidayAttribution: 'weekly' }]).success).toBe(
      false,
    );
  });
});
