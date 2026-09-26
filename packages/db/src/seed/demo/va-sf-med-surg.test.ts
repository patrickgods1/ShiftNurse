/**
 * The VA San Francisco medicine-surgery demo. What makes it a VA ward is federal: 8-hour tours
 * on the federal pay calendar, LVNs, no ratio law, Title 38 premium pay and all eleven federal
 * holidays. Each check below states one of those facts; the pay factors are Title 38's
 * (38 U.S.C. §7453), computed by hand.
 */

import { costSchedule, isoDate, ScheduleView } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { listHolidaysForUnit } from '../../repositories/config.js';
import { listPeriodsForUnit } from '../../repositories/schedule.js';
import { costContext, loadPeriodInput } from '../../repositories/solve-input.js';
import { realisticDemoChecks, useDemo } from './checks.test-support.js';

// A Thursday whose next Sunday (27 September) is not a federal pay-period start.
const TODAY = isoDate('2026-09-24');
const f = useDemo('va-sf-med-surg', TODAY);

/** Straight-rate factor over base for every priced history shift, keyed by date and tour. */
function payFactors(): Map<string, number> {
  const db = f.handle.db;
  const factors = new Map<string, number>();
  for (const period of listPeriodsForUnit(db, f.result.unitId)) {
    if (period.status !== 'published') continue;
    const input = loadPeriodInput(db, period);
    const cost = costSchedule(
      new ScheduleView({
        period,
        assignments: input.assignments,
        nurses: input.nurses,
        shiftTypes: input.shiftTypes,
      }),
      costContext(db, f.result.unitId, input.ruleSet),
    );
    const code = new Map(input.shiftTypes.map((s) => [s.id, s.abbreviation]));
    for (const a of cost.assignments) {
      factors.set(`${a.date}|${code.get(a.shiftTypeId)}`, a.straightRate / a.baseRate);
    }
  }
  return factors;
}

describe('the VA San Francisco med-surg demo', () => {
  it('works 8-hour day, evening and night tours', () => {
    expect(
      f.rows('SELECT abbreviation, start_time, duration_hours FROM shift_type ORDER BY sort_order'),
    ).toEqual([
      { abbreviation: 'D8', start_time: '07:30', duration_hours: 8 },
      { abbreviation: 'E8', start_time: '15:30', duration_hours: 8 },
      { abbreviation: 'N8', start_time: '23:30', duration_hours: 8 },
    ]);
  });

  it('starts the next four-week schedule on a federal pay-period boundary', () => {
    // Federal pay periods run from Sunday 12 January 2025 in 14-day steps: 27 September 2026 is
    // mid-period, 4 October 2026 (630 days, 45 periods on) starts one.
    expect([f.result.draftStart, f.result.draftEnd]).toEqual(['2026-10-04', '2026-10-31']);
  });

  it('staffs RNs with LVNs and nursing assistants, and no agency travelers', () => {
    expect(f.count("SELECT COUNT(*) n FROM nurse WHERE role='LPN'")).toBeGreaterThanOrEqual(7);
    expect(f.count("SELECT COUNT(*) n FROM nurse WHERE role='CNA'")).toBeGreaterThanOrEqual(8);
    expect(f.count("SELECT COUNT(*) n FROM nurse WHERE employment_type='agency'")).toBe(0);
    // Full-time is 80 hours a pay period: ten 8-hour tours.
    expect(
      f.count(
        "SELECT COUNT(*) n FROM nurse WHERE employment_type='full_time' AND contracted_hours_per_period != 80",
      ),
    ).toBe(0);
  });

  it('has no legislated patient ratios: VHA staffs to nursing hours per patient day', () => {
    expect(f.count('SELECT COUNT(*) n FROM ratio_rule')).toBe(0);
    expect(f.count('SELECT target_hours n FROM hppd_target')).toBe(8);
  });

  it('observes all eleven federal holidays, Veterans Day included', () => {
    const holidays = listHolidaysForUnit(f.handle.db, f.result.unitId);
    expect(holidays.filter((h) => h.date.startsWith('2026-'))).toHaveLength(11);
    expect(holidays.some((h) => h.date === '2026-11-11' && h.name === 'Veterans Day')).toBe(true);
  });

  it('pays Title 38 premiums: 10% on off-tours, 25% at weekends, double on holidays', () => {
    const factors = payFactors();
    const factor = (date: string, tour: string) => {
      const value = factors.get(`${date}|${tour}`);
      expect(value, `${date} ${tour}`).toBeDefined();
      return value!;
    };
    // Wednesday 17 June 2026, an ordinary weekday.
    expect(factor('2026-06-17', 'D8')).toBeCloseTo(1, 6);
    expect(factor('2026-06-17', 'E8')).toBeCloseTo(1.1, 6);
    // Saturday 20 June 2026.
    expect(factor('2026-06-20', 'D8')).toBeCloseTo(1.25, 6);
    // Friday 26 June 2026: the night tour runs into Saturday, so it earns both.
    expect(factor('2026-06-26', 'N8')).toBeCloseTo(1.1 * 1.25, 6);
    // Labor Day, Monday 7 September 2026.
    expect(factor('2026-09-07', 'D8')).toBeCloseTo(2, 6);
  });

  it('pays overtime after 8 hours in a day as well as after 40 in a week', () => {
    expect(
      f.rows('SELECT basis, threshold_hours, multiplier FROM overtime_rule ORDER BY basis'),
    ).toEqual([
      { basis: 'daily', threshold_hours: 8, multiplier: 1.5 },
      { basis: 'weekly', threshold_hours: 40, multiplier: 1.5 },
    ]);
  });

  realisticDemoChecks(f, 'va-sf-med-surg', TODAY);
});
