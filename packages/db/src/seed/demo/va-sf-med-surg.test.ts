/**
 * The VA San Francisco medicine-surgery demo. What makes it a VA ward is federal: a compressed
 * biweekly schedule (six 12s and an 8) on the federal pay calendar with overtime counted over the
 * pay period, LVNs, no ratio law, Title 38 premium pay and all eleven federal holidays. Each
 * check below states one of those facts; the pay factors are Title 38's (38 U.S.C. §7453),
 * computed by hand.
 */

import { addDays, costSchedule, daysBetween, isoDate, ScheduleView, solve } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { listHolidaysForUnit } from '../../repositories/config.js';
import { listIncompatibilityGroups } from '../../repositories/incompatibility.js';
import { getPeriod, listPeriodsForUnit } from '../../repositories/schedule.js';
import { costContext, loadPeriodInput } from '../../repositories/solve-input.js';
import { historyViolations, realisticDemoChecks, useDemo } from './checks.test-support.js';

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
  it('works 12-hour days and nights and an 8 that runs inside the day 12', () => {
    expect(
      f.rows(
        `SELECT st.abbreviation, st.start_time, st.duration_hours, outer_st.abbreviation within_code
           FROM shift_type st LEFT JOIN shift_type outer_st ON outer_st.id = st.within_shift_type_id
          ORDER BY st.sort_order`,
      ),
    ).toEqual([
      { abbreviation: 'D12', start_time: '07:00', duration_hours: 12, within_code: null },
      { abbreviation: 'N12', start_time: '19:00', duration_hours: 12, within_code: null },
      { abbreviation: 'D8', start_time: '07:00', duration_hours: 8, within_code: 'D12' },
    ]);
  });

  it('puts new grads on the 8 only beside an experienced RN on the 8 or the day 12', () => {
    // Every D8 with a new grad on it has an experienced RN on it or on that day's D12.
    const uncovered = f.count(
      `SELECT COUNT(*) n FROM assignment a JOIN nurse n ON n.id = a.nurse_id
         JOIN shift_type st ON st.id = a.shift_type_id
        WHERE st.abbreviation = 'D8' AND n.is_novice = 1
          AND NOT EXISTS (SELECT 1 FROM assignment b JOIN nurse m ON m.id = b.nurse_id
                 JOIN shift_type bst ON bst.id = b.shift_type_id
                WHERE b.date = a.date AND bst.abbreviation IN ('D8', 'D12')
                  AND m.role = 'RN' AND m.is_novice = 0)`,
    );
    expect(uncovered).toBe(0);
    const newGradEights = f.count(
      `SELECT COUNT(*) n FROM assignment a JOIN nurse n ON n.id = a.nurse_id
         JOIN shift_type st ON st.id = a.shift_type_id
        WHERE st.abbreviation = 'D8' AND n.is_novice = 1`,
    );
    expect(newGradEights).toBeGreaterThan(10);
  });

  it('gives full-time staff six 12s and one 8 a pay period, and marks anything past 80 overtime', () => {
    // Nurse-pay-periods untouched by leave or a call-off, so nothing moved the pattern.
    const patterns = f.rows<{ twelves: number; eights: number; hours: number; overtime: number }>(
      `SELECT SUM(st.duration_hours = 12) twelves, SUM(st.duration_hours = 8) eights,
              SUM(st.duration_hours) hours, SUM(a.is_overtime) overtime
         FROM assignment a JOIN nurse n ON n.id = a.nurse_id
         JOIN shift_type st ON st.id = a.shift_type_id
         JOIN schedule_period p ON p.id = a.period_id
        WHERE p.status = 'published' AND n.employment_type = 'full_time'
          AND NOT EXISTS (SELECT 1 FROM time_off_request t WHERE t.nurse_id = n.id
                 AND t.status = 'approved' AND t.start_date <= p.end_date AND t.end_date >= p.start_date)
          AND NOT EXISTS (SELECT 1 FROM call_off c WHERE c.period_id = p.id
                 AND (c.nurse_id = n.id OR c.replacement_assignment_id IN
                   (SELECT id FROM assignment WHERE nurse_id = n.id AND period_id = p.id)))
        GROUP BY n.id, p.id`,
    );
    const straight = patterns.filter((p) => p.overtime === 0);
    expect(straight.length).toBeGreaterThan(200);
    const sixAndOne = straight.filter((p) => p.twelves === 6 && p.eights === 1);
    expect(sixAndOne.length / straight.length).toBeGreaterThan(0.95);
    // An extra shift past 80 hours is a pick-up to cover a short shift, authorised as overtime.
    expect(patterns.filter((p) => p.hours > 80 && p.overtime === 0)).toEqual([]);
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
    // Full-time is 80 hours a pay period: six 12s and an 8.
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
    // Wednesday 17 June 2026, an ordinary weekday. The day 12 has one hour after 6 pm and the 8
    // none, so neither earns the night differential; the night 12 does.
    expect(factor('2026-06-17', 'D12')).toBeCloseTo(1, 6);
    expect(factor('2026-06-17', 'D8')).toBeCloseTo(1, 6);
    expect(factor('2026-06-17', 'N12')).toBeCloseTo(1.1, 6);
    // Saturday 20 June 2026.
    expect(factor('2026-06-20', 'D12')).toBeCloseTo(1.25, 6);
    // Friday 26 June 2026: the night 12 runs into Saturday, so it earns both.
    expect(factor('2026-06-26', 'N12')).toBeCloseTo(1.1 * 1.25, 6);
    // Labor Day, Monday 7 September 2026.
    expect(factor('2026-09-07', 'D12')).toBeCloseTo(2, 6);
  });

  it('pays overtime past a 12-hour tour or 80 hours in the pay period, not 40 in a week', () => {
    expect(
      f.rows('SELECT basis, threshold_hours, multiplier FROM overtime_rule ORDER BY basis'),
    ).toEqual([
      { basis: 'daily', threshold_hours: 12, multiplier: 1.5 },
      { basis: 'pay_period', threshold_hours: 80, multiplier: 1.5 },
    ]);
    // And the rule set judges overtime the same way, so the 44-hour week is legal.
    const maxHours = f.rows<{ params: string }>(
      `SELECT c.params FROM rule_config c WHERE c.rule_id = 'max-hours-per-week'`,
    );
    expect(JSON.parse(maxHours[0]!.params)).toMatchObject({
      overtimeByPayPeriod: true,
      payPeriodOvertimeThresholdHours: 80,
    });
  });

  it('prices the 44-hour week at straight time', () => {
    const db = f.handle.db;
    let atEighty = 0;
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
      const byNurse = new Map<string, { hours: number; overtime: number }>();
      for (const a of cost.assignments) {
        const row = byNurse.get(a.nurseId) ?? { hours: 0, overtime: 0 };
        row.hours += a.hours;
        row.overtime += a.overtimeHours;
        byNurse.set(a.nurseId, row);
      }
      for (const row of byNurse.values()) {
        if (row.hours === 80) {
          atEighty++;
          expect(row.overtime).toBe(0);
        }
      }
    }
    expect(atEighty).toBeGreaterThan(200);
  });

  describe('staff kept apart', () => {
    const groups = () => listIncompatibilityGroups(f.handle.db, f.result.unitId);
    const positionOf = (nurseId: string) =>
      f.rows<{ position: string }>(
        `SELECT COALESCE((SELECT st.abbreviation FROM assignment a
                  JOIN shift_type st ON st.id = a.shift_type_id
                 WHERE a.nurse_id = '${nurseId}' GROUP BY st.abbreviation
                 ORDER BY COUNT(*) DESC LIMIT 1), '') position`,
      )[0]!.position;

    it('keeps an RN pair, a trio of assistants and a clique of five LVNs apart, with reasons', () => {
      expect(groups()).toHaveLength(3);
      expect(
        groups()
          .map((g) => `${g.nurseIds.length} at most ${g.maxTogether}`)
          .sort(),
      ).toEqual(['2 at most 1', '3 at most 1', '5 at most 2']);
      for (const g of groups()) expect(g.reason.length).toBeGreaterThan(20);
      expect(new Set(groups().map((g) => g.name)).size).toBe(3);
      const roles = (ids: string[]) =>
        f
          .rows<{ role: string }>(
            `SELECT DISTINCT role FROM nurse WHERE id IN (${ids.map((i) => `'${i}'`).join(',')})`,
          )
          .map((r) => r.role);
      const pair = groups().find((g) => g.nurseIds.length === 2)!;
      const trio = groups().find((g) => g.nurseIds.length === 3)!;
      expect(roles(pair.nurseIds)).toEqual(['RN']);
      expect(roles(trio.nurseIds)).toEqual(['CNA']);
      const clique = groups().find((g) => g.nurseIds.length === 5)!;
      expect(roles(clique.nurseIds)).toEqual(['LPN']);
      // Kept apart as a real ward does it: on different tours, not by splitting the days.
      expect(pair.nurseIds.map(positionOf).sort()).toEqual(['D12', 'N12']);
      // Nobody in a group is a charge nurse or a new grad: the unit cannot lose either to a
      // separation.
      const flagged = f.count(
        `SELECT COUNT(*) n FROM nurse n JOIN incompatibility_member m ON m.nurse_id = n.id
          WHERE n.is_charge_eligible = 1 OR n.is_novice = 1`,
      );
      expect(flagged).toBe(0);
    });

    it('dates the separations: the RN pair from before the schedule, the trio for a while', () => {
      const pair = groups().find((g) => g.nurseIds.length === 2)!;
      const trio = groups().find((g) => g.nurseIds.length === 3)!;
      expect(pair.startsOn! < f.result.draftStart).toBe(true);
      expect(pair.endsOn).toBeUndefined();
      expect(trio.startsOn! < f.result.draftStart).toBe(true);
      expect(trio.endsOn! > f.result.draftEnd).toBe(true);
      expect(trio.endsOn! < addDays(f.result.draftEnd, 60)).toBe(true);
    });

    it('never put them on the floor together once a separation applied', () => {
      expect(historyViolations(f, 'soft').get('incompatible_staff_together') ?? 0).toBe(0);
      expect(historyViolations(f).get('incompatible_staff_unbuffered') ?? 0).toBe(0);
      // Kept apart by tour, not by losing shifts: each member works about as many a week once
      // the group applies as in the six weeks before it.
      const perWeek = (id: string, from: string, to: string) =>
        f.count(
          `SELECT COUNT(*) n FROM assignment
            WHERE nurse_id = '${id}' AND date >= '${from}' AND date < '${to}'`,
        ) /
        (daysBetween(isoDate(from), isoDate(to)) / 7);
      for (const g of groups()) {
        for (const id of g.nurseIds) {
          const before = perWeek(id, addDays(g.startsOn!, -42), g.startsOn!);
          const after = perWeek(id, g.startsOn!, f.result.draftStart);
          expect(before).toBeGreaterThan(0);
          expect(after / before, id).toBeGreaterThan(0.75);
        }
      }
    });

    it('lets two of the five LVNs share a tour, as their cap allows, but never three', () => {
      const clique = groups().find((g) => g.nurseIds.length === 5)!;
      const members = clique.nurseIds.map((i) => `'${i}'`).join(',');
      const onTogether = f.rows<{ n: number }>(
        `SELECT COUNT(*) n FROM assignment a JOIN shift_type st ON st.id = a.shift_type_id
          WHERE a.nurse_id IN (${members}) AND a.date >= '${clique.startsOn}'
            AND a.date < '${f.result.draftStart}' AND st.within_shift_type_id IS NULL
          GROUP BY a.date, a.shift_type_id`,
      );
      expect(onTogether.some((r) => r.n === 2)).toBe(true);
      expect(onTogether.every((r) => r.n <= 2)).toBe(true);
    });

    it('lets Generate keep them apart on the next schedule', () => {
      const input = loadPeriodInput(f.handle.db, getPeriod(f.handle.db, f.result.draftPeriodId)!);
      expect(input.incompatibilityGroups).toHaveLength(3);
      const report = solve(input, { seed: 1, maxIterations: 200_000 });
      expect(report.softViolations.filter((v) => v.code === 'incompatible_staff_together')).toEqual(
        [],
      );
      expect(report.objective.incompatibility).toBe(0);
    }, 60_000);
  });

  realisticDemoChecks(f, 'va-sf-med-surg', TODAY);
});
