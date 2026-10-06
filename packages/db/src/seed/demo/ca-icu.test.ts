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
      f.rows(
        `SELECT basis, threshold_hours, multiplier, pyramiding FROM overtime_rule
           ORDER BY basis, threshold_hours`,
      ),
    ).toEqual([
      // IWC Wage Order 5 § 3(B)(8): on a day past the agreed workdays, double after 8 hours.
      { basis: 'beyond_scheduled_days', threshold_hours: 8, multiplier: 2, pyramiding: null },
      // IWC Wage Order 5 § 3(B)(8): past 12 hours in a workday, double.
      { basis: 'daily', threshold_hours: 12, multiplier: 2, pyramiding: null },
      // Labor Code § 510: the seventh consecutive day is time and a half, and double past 8.
      { basis: 'seventh_day', threshold_hours: 0, multiplier: 1.5, pyramiding: null },
      { basis: 'seventh_day', threshold_hours: 8, multiplier: 2, pyramiding: null },
      // § 510 as the DLSE reads it: an hour paid as daily overtime does not count to the 40.
      { basis: 'weekly', threshold_hours: 40, multiplier: 1.5, pyramiding: 'none' },
    ]);
  });

  it('runs under the California preset: Title 22 ratios, break cover and no mandatory overtime', () => {
    const unit = f.rows<Record<string, unknown>>(
      `SELECT jurisdiction, charge_nurse_takes_patients, break_minutes_per_nurse,
              charge_covers_breaks FROM unit WHERE id = '${f.result.unitId}'`,
    );
    expect(unit).toEqual([
      {
        jurisdiction: 'CA',
        charge_nurse_takes_patients: 0,
        break_minutes_per_nurse: 60,
        charge_covers_breaks: 1,
      },
    ]);
    // Title 22's ICU ceiling for every patient, beside the unit's own tier rules at 2 and 1.
    expect(
      f.rows(`SELECT max_patients_per_nurse max FROM ratio_rule
                WHERE role = 'RN' AND acuity_tier_id IS NULL AND active = 1`),
    ).toEqual([{ max: 2 }]);
    const ruleSetIds = f.rows<{ rule_set_id: string }>(
      'SELECT DISTINCT rule_set_id FROM schedule_period',
    );
    expect(ruleSetIds).toHaveLength(1);
    const [config] = f.rows<{ enabled: number; params: string }>(
      `SELECT enabled, params FROM rule_config WHERE rule_set_id = '${ruleSetIds[0]!.rule_set_id}'
         AND rule_id = 'no-mandatory-overtime'`,
    );
    expect(config!.enabled).toBe(1);
    expect(JSON.parse(config!.params).maxRequiredConsecutiveHours).toBe(12);
  });

  realisticDemoChecks(f, 'ca-icu', TODAY);
});
