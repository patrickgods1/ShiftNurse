/**
 * The community-hospital med-surg demo: the unit most evaluators will recognise as their own.
 * Expected values are real-world facts, not re-derivations of the seeder's arithmetic.
 */

import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { listHolidaysForUnit } from '../../repositories/config.js';
import { realisticDemoChecks, useDemo } from './checks.test-support.js';

const TODAY = isoDate('2026-09-17');
const f = useDemo('community-med-surg', TODAY);

describe('the community med-surg demo', () => {
  it('staffs 28 beds with RNs and CNAs, as most acute-care hospitals do', () => {
    expect(f.count("SELECT COUNT(*) n FROM nurse WHERE role='RN'")).toBe(34);
    expect(f.count("SELECT COUNT(*) n FROM nurse WHERE role='CNA'")).toBe(15);
    expect(f.count("SELECT COUNT(*) n FROM nurse WHERE role='LPN'")).toBe(0);
    expect(f.count('SELECT MAX(projected_census) n FROM census_forecast')).toBeLessThanOrEqual(28);
    expect(f.count('SELECT MAX(actual_census) n FROM census_forecast')).toBeLessThanOrEqual(28);
  });

  it('runs 12-hour days and nights on a six-week schedule starting next Sunday', () => {
    expect(
      f.rows('SELECT abbreviation, start_time, duration_hours FROM shift_type ORDER BY sort_order'),
    ).toEqual([
      { abbreviation: 'D12', start_time: '07:00', duration_hours: 12 },
      { abbreviation: 'N12', start_time: '19:00', duration_hours: 12 },
    ]);
    // Thursday 17 September 2026: next Sunday is the 20th; six weeks end Saturday 31 October.
    expect([f.result.draftStart, f.result.draftEnd]).toEqual(['2026-09-20', '2026-10-31']);
  });

  it('holds routine patients to one RN per five', () => {
    expect(
      f.rows(`SELECT r.max_patients_per_nurse max FROM ratio_rule r JOIN acuity_tier t
                ON t.id = r.acuity_tier_id WHERE t.level = 1 AND r.role = 'RN'`),
    ).toEqual([{ max: 5 }]);
  });

  it('observes the six holidays hospitals usually pay premium for', () => {
    const names = new Set(listHolidaysForUnit(f.handle.db, f.result.unitId).map((h) => h.name));
    expect(names).toEqual(
      new Set([
        "New Year's Day",
        'Memorial Day',
        'Independence Day',
        'Labor Day',
        'Thanksgiving Day',
        'Christmas Day',
      ]),
    );
  });

  it('pays experienced RNs more than new graduates', () => {
    const [junior, senior] = [
      "SELECT AVG(r.hourly_rate) n FROM pay_rate r JOIN nurse n ON n.id = r.nurse_id WHERE n.role = 'RN' AND n.is_novice = 1",
      "SELECT AVG(r.hourly_rate) n FROM pay_rate r JOIN nurse n ON n.id = r.nurse_id WHERE n.role = 'RN' AND n.is_charge_eligible = 1",
    ].map(f.count);
    expect(senior!).toBeGreaterThan(junior! + 5);
  });

  realisticDemoChecks(f, 'community-med-surg', TODAY);
});
