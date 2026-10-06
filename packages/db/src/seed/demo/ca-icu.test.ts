/**
 * The California ICU demo: a unit where the ratios are law (Title 22 §70217) and every nurse is
 * critical-care trained.
 */

import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { realisticDemoChecks, useDemo } from './checks.test-support.js';

const TODAY = isoDate('2026-09-17');
const f = useDemo('ca-icu', TODAY);

describe('the California ICU demo', () => {
  it('caps assignments at two patients per RN, and one for a critical patient', () => {
    expect(
      f.rows(`SELECT t.level, r.max_patients_per_nurse max FROM ratio_rule r JOIN acuity_tier t
                ON t.id = r.acuity_tier_id WHERE r.role = 'RN' ORDER BY t.level`),
    ).toEqual([
      { level: 1, max: 2 },
      { level: 2, max: 1 },
    ]);
    expect(f.count('SELECT MAX(projected_census) n FROM census_forecast')).toBeLessThanOrEqual(12);
  });

  it('trains every RN in ACLS and needs four ACLS nurses on every shift', () => {
    expect(
      f.count(`SELECT COUNT(*) n FROM nurse WHERE role = 'RN' AND id NOT IN (
                 SELECT nc.nurse_id FROM nurse_credential nc JOIN credential c
                 ON c.id = nc.credential_id WHERE c.code = 'ACLS')`),
    ).toBe(0);
    expect(f.rows('SELECT DISTINCT min_count n FROM shift_credential_requirement')).toEqual([
      { n: 4 },
    ]);
  });

  it("pays overtime on California's 12-hour alternative workweek", () => {
    expect(
      f.rows('SELECT basis, threshold_hours, multiplier FROM overtime_rule ORDER BY basis'),
    ).toEqual([
      { basis: 'daily', threshold_hours: 12, multiplier: 2 },
      { basis: 'weekly', threshold_hours: 40, multiplier: 1.5 },
    ]);
  });

  realisticDemoChecks(f, 'ca-icu', TODAY);
});
