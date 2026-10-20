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

  it('refuses a way of dating a holiday shift it does not know', () => {
    expect(unitsSchemas.update.safeParse(['u-1', { holidayAttribution: 'weekly' }]).success).toBe(
      false,
    );
  });
});
