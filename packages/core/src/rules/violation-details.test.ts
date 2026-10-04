/** Reading a violation's numbers: a missing one stops the pass instead of reading as zero. */

import { describe, expect, it } from 'vitest';
import { detailNumber, detailOptional, detailString, type Violation } from './types.js';

const short = (details: Record<string, unknown>): Violation => ({
  ruleId: 'coverage-minimums',
  ruleName: 'Coverage minimums',
  severity: 'hard',
  code: 'understaffed',
  message: 'Sat night is short 2 RNs.',
  nurseIds: [],
  dates: [],
  assignmentIds: [],
  details,
});

describe('reading what a rule reported', () => {
  it('reads the shortfall a rule reported', () => {
    expect(detailNumber(short({ shortfall: 2 }), 'shortfall')).toBe(2);
    expect(detailString(short({ role: 'RN' }), 'role')).toBe('RN');
  });

  it('refuses to read a renamed shortfall as zero short', () => {
    expect(() => detailNumber(short({ shortBy: 2 }), 'shortfall')).toThrow(/no number "shortfall"/);
    expect(() => detailNumber(short({ shortfall: '2' }), 'shortfall')).toThrow();
    expect(() => detailString(short({}), 'role')).toThrow(/no "role"/);
  });

  it('lets a requirement for any role leave its role out', () => {
    expect(detailOptional(short({}), 'role')).toBeUndefined();
  });
});
