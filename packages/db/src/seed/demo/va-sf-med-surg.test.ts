/**
 * The VA San Francisco medicine-surgery demo. What makes it a VA ward is federal: a compressed
 * biweekly schedule (six 12s and an 8) on the federal pay calendar with overtime counted over the
 * pay period, LVNs, no ratio law, Title 38 premium pay and all eleven federal holidays. Each
 * check below states one of those facts; the pay factors are Title 38's (38 U.S.C. §7453),
 * computed by hand.
 */

import {
  type Assignment,
  addDays,
  costSchedule,
  daysBetween,
  isoDate,
  type Nurse,
  restMinutesBetween,
  ScheduleView,
  type ShiftType,
  shiftWindow,
  solve,
  weekdayOf,
} from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { getUnit, listHolidaysForUnit, listUnits } from '../../repositories/config.js';
import { listIncompatibilityGroups } from '../../repositories/incompatibility.js';
import {
  listFmlaCertifications,
  listLeaveBalancesForNurse,
} from '../../repositories/leave-balances.js';
import { listLeaveBidRounds, listLeaveBids } from '../../repositories/leave-bidding.js';
import { listNurseUnitsForUnit } from '../../repositories/nurse-units.js';
import { listPreceptorships } from '../../repositories/preceptorships.js';
import {
  listCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
} from '../../repositories/roster.js';
import { getPeriod, listPeriodsForUnit } from '../../repositories/schedule.js';
import { costContext, loadPeriodInput } from '../../repositories/solve-input.js';
import { listTimeOffForNurse } from '../../repositories/timeoff.js';
import { historyViolations, realisticDemoChecks, useDemo } from './checks.test-support.js';
import { slow } from './slow.test-support.js';

// A Thursday whose next Sunday (27 September) is not a federal pay-period start.
const TODAY = isoDate('2026-09-24');
const f = useDemo('va-sf-med-surg', TODAY);

/**
 * Straight-rate factor over base for every priced history shift, keyed by date and tour, and the
 * hours that tour earned the night differential on (0 where it has no night line).
 */
const nightHours = new Map<string, { hours: number; rateOverBase: number } | null>();

function payFactors(): Map<string, number> {
  const db = f.handle.db;
  const factors = new Map<string, number>();
  nightHours.clear();
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
      const key = `${a.date}|${code.get(a.shiftTypeId)}`;
      factors.set(key, a.straightRate / a.baseRate);
      const night = a.lines.find((l) => l.kind === 'night');
      nightHours.set(
        key,
        night ? { hours: night.hours, rateOverBase: night.rate / a.baseRate } : null,
      );
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
          WHERE st.unit_id = '${f.result.unitId}'
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
    // Wednesday 17 June 2026, an ordinary weekday. By the clock (18:00-06:00, whole tour at 4+
    // hours): the 07:00-19:00 day 12 has 18:00-19:00 = 1 hour in the window, short of 4, so it
    // earns 10% on that 1 of its 12 hours, on the base rate only, and its straight rate stays
    // base; the 8 (07:00-15:00) has none; the night 12 (19:00-07:00) has 11 hours in the window
    // and earns 1.1 on all 12.
    expect(factor('2026-06-17', 'D12')).toBeCloseTo(1, 6);
    expect(nightHours.get('2026-06-17|D12')).toEqual({
      hours: 1,
      rateOverBase: expect.closeTo(0.1, 6),
    });
    expect(factor('2026-06-17', 'D8')).toBeCloseTo(1, 6);
    expect(nightHours.get('2026-06-17|D8')).toBeNull();
    expect(factor('2026-06-17', 'N12')).toBeCloseTo(1.1, 6);
    // Saturday 20 June 2026.
    expect(factor('2026-06-20', 'D12')).toBeCloseTo(1.25, 6);
    // Friday 26 June 2026: the night 12 runs into Saturday, so it earns both.
    expect(factor('2026-06-26', 'N12')).toBeCloseTo(1.1 * 1.25, 6);
    // Labor Day, Monday 7 September 2026.
    expect(factor('2026-09-07', 'D12')).toBeCloseTo(2, 6);
  });

  it('pays the night differential on all of an 8.5-hour 15:30-24:00 tour, six hours of it after 6 pm', () => {
    // 18:00-24:00 is 6 hours in the window, at least 4, so the 10% covers all 8.5 hours.
    const db = f.handle.db;
    const draft = getPeriod(db, f.result.draftPeriodId)!;
    const input = loadPeriodInput(db, draft);
    const evening: ShiftType = {
      ...input.shiftTypes[0]!,
      id: 'synthetic-evening',
      name: 'Evening 8.5',
      abbreviation: 'E8',
      startTime: '15:30',
      durationHours: 8.5,
      isNight: false,
      withinShiftTypeId: null,
    };
    const nurse = input.nurses.find((n) => n.role === 'CNA' && n.employmentType === 'full_time')!;
    const date = isoDate('2026-10-07'); // A Wednesday: no weekend or holiday premium.
    const assignment: Assignment = {
      id: 'synthetic-assignment',
      periodId: draft.id,
      nurseId: nurse.id,
      shiftTypeId: evening.id,
      date,
      source: 'manual',
      isLocked: false,
      isCharge: false,
      isOvertime: false,
    };
    const cost = costSchedule(
      new ScheduleView({
        period: draft,
        assignments: [assignment],
        nurses: input.nurses,
        shiftTypes: [...input.shiftTypes, evening],
      }),
      costContext(db, f.result.unitId, input.ruleSet),
    ).assignments[0]!;
    expect(cost.straightRate / cost.baseRate).toBeCloseTo(1.1, 6);
    const night = cost.lines.find((l) => l.kind === 'night')!;
    expect(night.hours).toBe(8.5);
  });

  it('is under Title 38: the federal preset, an 11-hour rest and two weekends off in four', () => {
    expect(f.rows<{ jurisdiction: string }>('SELECT jurisdiction FROM unit')[0]!.jurisdiction).toBe(
      'US-VA',
    );
    const periods = f.rows<{ rule_set_id: string }>(
      'SELECT DISTINCT rule_set_id FROM schedule_period',
    );
    expect(periods).toHaveLength(1);
    const configs = f.rows<{ rule_id: string; enabled: number; params: string }>(
      `SELECT rule_id, enabled, params FROM rule_config WHERE rule_set_id = '${periods[0]!.rule_set_id}'`,
    );
    const config = (id: string) => {
      const c = configs.find((x) => x.rule_id === id)!;
      return { enabled: c.enabled === 1, params: JSON.parse(c.params) };
    };
    expect(config('no-mandatory-overtime')).toMatchObject({
      enabled: true,
      params: { maxMandatedWeeklyHours: 40 },
    });
    expect(config('min-rest-between-shifts').params.minRestHours).toBe(11);
    expect(config('weekend-pattern')).toMatchObject({
      enabled: true,
      params: { maxConsecutiveWeekends: 2, maxWeekendsPerPeriod: 2 },
    });
  });

  it('never requires overtime past 40 hours of anyone who did not offer it', () => {
    expect(historyViolations(f).get('mandatory_overtime') ?? 0).toBe(0);
    expect(f.count('SELECT COUNT(*) n FROM overtime_volunteer')).toBeGreaterThan(10);
    // Volunteers are a minority, about a third of the staff who can offer.
    const offering = f.count('SELECT COUNT(DISTINCT nurse_id) n FROM overtime_volunteer');
    const eligible = f.count(
      "SELECT COUNT(*) n FROM nurse WHERE employment_type IN ('full_time', 'part_time')",
    );
    expect(offering / eligible).toBeGreaterThan(0.2);
    expect(offering / eligible).toBeLessThan(0.5);
  });

  it('gives two weekends off in every four and eleven hours between tours', () => {
    expect(historyViolations(f, 'soft').get('excess_weekends') ?? 0).toBe(0);
    const tours = f.rows<{
      nurse_id: string;
      date: string;
      start_time: string;
      duration_hours: number;
    }>(
      `SELECT a.nurse_id, a.date, st.start_time, st.duration_hours FROM assignment a
         JOIN shift_type st ON st.id = a.shift_type_id ORDER BY a.nurse_id, a.date`,
    );
    let previous: (typeof tours)[number] | undefined;
    let tooClose = 0;
    for (const t of tours) {
      if (previous?.nurse_id === t.nurse_id) {
        const rest = restMinutesBetween(
          shiftWindow(isoDate(previous.date), {
            startTime: previous.start_time,
            durationHours: previous.duration_hours,
          }),
          shiftWindow(isoDate(t.date), {
            startTime: t.start_time,
            durationHours: t.duration_hours,
          }),
        );
        if (rest < 11 * 60) tooClose++;
      }
      previous = t;
    }
    expect(tooClose).toBe(0);
  });

  it('pays overtime beyond the scheduled tour or past 80 hours in the pay period, not 40 in a week', () => {
    expect(
      f.rows('SELECT basis, threshold_hours, multiplier FROM overtime_rule ORDER BY basis'),
    ).toEqual([
      { basis: 'beyond_scheduled_tour', threshold_hours: 0, multiplier: 1.5 },
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

  it('has three volunteered holdovers in the published history, none required', () => {
    const held = f.rows<{ code: string; minutes: number; mandated: number | null; status: string }>(
      `SELECT st.abbreviation code, a.holdover_minutes minutes, a.holdover_mandated mandated, p.status
         FROM assignment a JOIN shift_type st ON st.id = a.shift_type_id
         JOIN schedule_period p ON p.id = a.period_id
        WHERE a.holdover_minutes > 0 ORDER BY a.holdover_minutes`,
    );
    expect(held).toEqual([
      { code: 'N12', minutes: 30, mandated: 0, status: 'published' },
      { code: 'D8', minutes: 45, mandated: 0, status: 'published' },
      { code: 'D12', minutes: 90, mandated: 0, status: 'published' },
    ]);
    // Each was recorded through the repository, so each has its audit entry.
    const audited = f
      .rows<{ after: string }>(
        `SELECT after FROM audit_log WHERE entity_type = 'assignment' AND action = 'update'`,
      )
      .map((r) => JSON.parse(r.after) as { holdoverMinutes?: number; holdoverMandated?: boolean })
      .filter((x) => (x.holdoverMinutes ?? 0) > 0);
    expect(audited.map((x) => [x.holdoverMinutes, x.holdoverMandated]).sort()).toEqual([
      [30, false],
      [45, false],
      [90, false],
    ]);
    // One nurse each, and nothing a holdover could break (rest, hours, required overtime) fires.
    expect(
      f.count('SELECT COUNT(DISTINCT nurse_id) n FROM assignment WHERE holdover_minutes > 0'),
    ).toBe(3);
    // The same history seeded without the holdovers has exactly these violations (counted by
    // hand from that run): holdovers add none, hard or soft.
    expect([...historyViolations(f)].sort()).toEqual([
      ['over_contracted_hours', 42],
      ['understaffed', 8],
    ]);
    expect([...historyViolations(f, 'soft')].sort()).toEqual([
      ['short_recovery_after_nights', 163],
      ['under_contracted_hours', 20],
    ]);
  });

  it('prices an 8 held over 45 minutes as three quarters of an hour of overtime at time and a half', () => {
    const db = f.handle.db;
    const held = f.rows<{ id: string; nurse_id: string; period_id: string; date: string }>(
      `SELECT a.id, a.nurse_id, a.period_id, a.date FROM assignment a
         JOIN shift_type st ON st.id = a.shift_type_id
        WHERE st.abbreviation = 'D8' AND a.holdover_minutes = 45`,
    );
    expect(held).toHaveLength(1);
    const { id, nurse_id: nurseId, period_id: periodId, date } = held[0]!;
    // A Monday and no holiday, so no premium besides overtime; the nursing assistant's General
    // Schedule rate is 29 + 0.40 for each of 14 years of service = 34.60.
    expect(weekdayOf(isoDate(date))).toBe(1);
    expect(
      f.rows<{ hourly_rate: number }>(
        `SELECT hourly_rate FROM pay_rate WHERE nurse_id = '${nurseId}'`,
      ),
    ).toEqual([{ hourly_rate: 34.6 }]);

    const period = getPeriod(db, periodId)!;
    const input = loadPeriodInput(db, period);
    const price = (assignments: readonly Assignment[]) =>
      costSchedule(
        new ScheduleView({
          period,
          assignments,
          nurses: input.nurses,
          shiftTypes: input.shiftTypes,
        }),
        costContext(db, f.result.unitId, input.ruleSet),
      );
    const withHoldover = price(input.assignments);
    const without = price(
      input.assignments.map((a) => (a.id === id ? { ...a, holdoverMinutes: 0 } : a)),
    );
    const row = (cost: typeof withHoldover) => cost.assignments.find((a) => a.assignmentId === id)!;
    // 45 minutes = 0.75 hour; 0.75 x $34.60 x 1.5 = $38.925, and the 8 itself is unchanged.
    expect(row(withHoldover).hours - row(without).hours).toBeCloseTo(0.75, 10);
    expect(row(withHoldover).overtimeHours).toBeCloseTo(0.75, 10);
    expect(row(without).overtimeHours).toBe(0);
    expect(withHoldover.totals.total - without.totals.total).toBeCloseTo(38.925, 6);
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
      const employment = new Map(
        f
          .rows<{ id: string; employment_type: string }>('SELECT id, employment_type FROM nurse')
          .map((n) => [n.id, n.employment_type]),
      );
      for (const g of groups()) {
        let beforeTotal = 0;
        let afterTotal = 0;
        for (const id of g.nurseIds) {
          const before = perWeek(id, addDays(g.startsOn!, -42), g.startsOn!);
          const after = perWeek(id, g.startsOn!, f.result.draftStart);
          expect(before).toBeGreaterThan(0);
          beforeTotal += before;
          afterTotal += after;
          // A full-timer keeps the same hours. A part-timer or intermittent nurse works as the
          // unit needs them, two or three tours a week, so a six-week count of theirs swings by
          // a third on its own; the group as a whole must still hold.
          if (employment.get(id) === 'full_time') expect(after / before, id).toBeGreaterThan(0.75);
        }
        expect(afterTotal / beforeTotal, g.name).toBeGreaterThan(0.75);
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

    it(
      'lets Generate keep them apart on the next schedule',
      () => {
        const input = loadPeriodInput(f.handle.db, getPeriod(f.handle.db, f.result.draftPeriodId)!);
        expect(input.incompatibilityGroups).toHaveLength(3);
        const report = solve(input, { seed: 1, maxIterations: 200_000 });
        expect(
          report.softViolations.filter((v) => v.code === 'incompatible_staff_together'),
        ).toEqual([]);
        expect(report.objective.incompatibility).toBe(0);
      },
      slow(60_000),
    );
  });

  describe('leave, certifications, orientation, floats and bidding', () => {
    const db = () => f.handle.db;
    const nurses = () => listNursesForUnit(db(), f.result.unitId);
    const employees = () =>
      nurses().filter((n) => n.employmentType === 'full_time' || n.employmentType === 'part_time');

    it('gives every full- and part-time nurse an annual and a sick balance as of the last pay period', () => {
      for (const n of employees()) {
        const balances = listLeaveBalancesForNurse(db(), n.id);
        // Federal staff keep annual leave, not PTO.
        expect(balances.map((b) => b.type).sort(), n.lastName).toEqual(['annual', 'sick']);
        for (const b of balances) {
          expect(b.balanceHours).toBeGreaterThanOrEqual(0);
          expect(b.asOf).toBe(addDays(f.result.draftStart, -1));
        }
        // The ceilings: Title 38 RNs 685 (VA Handbook 5011 pt. III ch. 2), Title 5 LVNs and
        // nursing assistants 240 (5 U.S.C. § 6304(a)).
        expect(
          balances.find((b) => b.type === 'annual')!.balanceHours,
          n.lastName,
        ).toBeLessThanOrEqual(n.role === 'RN' ? 685 : 240);
      }
      // Per-diem staff keep no balance.
      for (const n of nurses().filter((x) => x.employmentType === 'per_diem')) {
        expect(listLeaveBalancesForNurse(db(), n.id)).toEqual([]);
      }
    });

    it('shows annual leave from tens of hours up to the carry-over cap and more, and sick leave beyond it', () => {
      const pto = employees().map(
        (n) => listLeaveBalancesForNurse(db(), n.id).find((b) => b.type === 'annual')!.balanceHours,
      );
      const sick = employees().map(
        (n) => listLeaveBalancesForNurse(db(), n.id).find((b) => b.type === 'sick')!.balanceHours,
      );
      expect(Math.min(...pto)).toBeLessThan(100);
      expect(Math.max(...pto)).toBeGreaterThan(200);
      // Sick leave is not capped: a long-serving nurse has more than the annual cap allows.
      expect(Math.max(...sick)).toBeGreaterThan(240);
    });

    it('has no PTO balance anywhere: federal vacation is annual leave', () => {
      const types = nurses().flatMap((n) =>
        listLeaveBalancesForNurse(db(), n.id).map((b) => b.type),
      );
      expect(types).not.toContain('pto');
      expect(types.filter((t) => t === 'annual').length).toBe(employees().length);
    });

    it('holds annual balances at the ceiling for staff who have earned past it', () => {
      // Hand-known consequence of the ceilings, not of the engine's arithmetic: with 8 hours a
      // pay period an RN with years of service has earned past 685, and an LVN past 240, so
      // the long-serving ones sit exactly on their ceiling rather than over it.
      const annual = (role: (n: Nurse) => boolean) =>
        employees()
          .filter(role)
          .map(
            (n) =>
              listLeaveBalancesForNurse(db(), n.id).find((b) => b.type === 'annual')!.balanceHours,
          );
      expect(annual((n) => n.role === 'RN')).toContain(685);
      expect(annual((n) => n.role === 'LPN')).toContain(240);
    });

    it('puts the unit under Title 5 FMLA through the VA preset', () => {
      expect(getUnit(db(), f.result.unitId)?.leavePolicy?.fmla.regime).toBe('title5');
    });

    it('gives some long-serving staff a VA hire date after their federal service began', () => {
      const bridged = nurses().filter((n) => n.hireDate !== undefined);
      // About one in six of the 6+ year employees: five of 45 staff in this seeding.
      expect(bridged).toHaveLength(5);
      for (const n of bridged) {
        expect(n.hireDate! > n.seniorityDate, n.lastName).toBe(true);
        // Two to four years of earlier service, so still on staff before the history began.
        expect(daysBetween(n.seniorityDate, n.hireDate!)).toBeGreaterThanOrEqual(2 * 365);
        expect(daysBetween(n.seniorityDate, n.hireDate!)).toBeLessThanOrEqual(4 * 365);
      }
      // Everyone else's employment began on their seniority date.
      expect(nurses().some((n) => n.hireDate === undefined)).toBe(true);
    });

    it('records vacation requests as annual leave, never PTO', () => {
      const requests = nurses().flatMap((n) => listTimeOffForNurse(db(), n.id));
      expect(requests.filter((r) => r.type === 'pto')).toEqual([]);
      expect(requests.filter((r) => r.type === 'annual').length).toBeGreaterThan(10);
    });

    it('records three FMLA certifications on three nurses, one intermittent, none on a charge nurse', () => {
      const certs = nurses().flatMap((n) =>
        listFmlaCertifications(db(), n.id).map((c) => ({ ...c, nurse: n })),
      );
      expect(certs).toHaveLength(3);
      expect(new Set(certs.map((c) => c.nurseId)).size).toBe(3);
      expect(certs.filter((c) => c.intermittent)).toHaveLength(1);
      expect(certs.some((c) => c.nurse.isChargeEligible)).toBe(false);
      const intermittent = certs.find((c) => c.intermittent)!;
      // Twelve months (365 days inclusive), begun inside the history.
      expect(daysBetween(intermittent.startDate, intermittent.endDate) + 1).toBe(365);
      expect(intermittent.startDate < f.result.draftStart).toBe(true);
      expect(certs.filter((c) => !c.intermittent && c.endDate < TODAY)).toHaveLength(1);
      expect(
        certs.filter((c) => !c.intermittent && c.startDate <= TODAY && c.endDate >= TODAY),
      ).toHaveLength(1);
      // The history's leave is already modelled: no absences were added for them.
      expect(certs.every((c) => c.note && c.note.length > 10)).toBe(true);
    });

    it('orients two new grads for 12 weeks from their hire date, with a preceptor who never leaves them', () => {
      const records = listPreceptorships(db(), f.result.unitId);
      expect(records).toHaveLength(2);
      const preceptorCredential = listCredentials(db()).find((c) => c.code === 'PRECEPTOR')!;
      const holders = new Set(
        listNurseCredentialsForUnit(db(), f.result.unitId)
          .filter((c) => c.credentialId === preceptorCredential.id)
          .map((c) => c.nurseId),
      );
      for (const r of records) {
        const orientee = nurses().find((n) => n.id === r.orienteeId)!;
        const preceptor = nurses().find((n) => n.id === r.preceptorId)!;
        expect(orientee.isNovice).toBe(true);
        expect(r.startDate).toBe(orientee.seniorityDate);
        // Twelve weeks is 84 days counting the first, so the last is 83 days on.
        expect(daysBetween(r.startDate, r.endDate)).toBe(83);
        expect(holders.has(preceptor.id)).toBe(true);
        expect(preceptor.role).toBe('RN');
        expect(preceptor.employmentType).toBe('full_time');
        expect(preceptor.isNovice).toBe(false);
        const worked = f.count(
          `SELECT COUNT(*) n FROM assignment WHERE nurse_id = '${orientee.id}'
              AND date >= '${r.startDate}' AND date <= '${r.endDate}' AND date < '${f.result.draftStart}'`,
        );
        expect(worked, orientee.lastName).toBeGreaterThan(5);
      }
      // One orientation runs on into the schedule; the other ended in the history.
      expect(records.filter((r) => r.endDate >= f.result.draftStart)).toHaveLength(1);
      expect(records.filter((r) => r.endDate < f.result.draftStart)).toHaveLength(1);
      expect(historyViolations(f).get('orientee_without_preceptor') ?? 0).toBe(0);
    });

    it('gives five staff float memberships on a telemetry unit, and the 4A unit is the one that opens', () => {
      const units = listUnits(db());
      expect(units.map((u) => u.name)).toEqual([
        '4A Medicine-Surgery (VA San Francisco sample)',
        '4B Telemetry (VA San Francisco sample)',
      ]);
      expect(f.result.unitId).toBe(units[0]!.id);
      const tele = units[1]!;
      expect(tele.unitType).toBe('Telemetry');
      expect(f.count(`SELECT COUNT(*) n FROM nurse WHERE unit_id = '${tele.id}'`)).toBe(0);
      const members = listNurseUnitsForUnit(db(), tele.id);
      expect(members).toHaveLength(5);
      const roles = members.map((m) => nurses().find((n) => n.id === m.nurseId)!);
      expect(roles.filter((n) => n.role === 'RN')).toHaveLength(4);
      expect(roles.filter((n) => n.role === 'LPN')).toHaveLength(1);
      expect(roles.some((n) => n.isChargeEligible || n.isNovice)).toBe(false);
      expect(members.every((m) => m.competency?.includes('no titratable drips'))).toBe(true);
    });

    it('opens the annual-leave bid for the coming leave year and leaves it unawarded', () => {
      const [round, ...others] = listLeaveBidRounds(db(), f.result.unitId);
      expect(others).toEqual([]);
      expect(round!.name).toBe('2027 annual leave');
      // Pay periods start every 14 days from Sunday 12 January 2025: 10 January 2027 is the 53rd
      // after it (728 days), and 8 January 2028 is the day before the next leave year's first.
      expect([round!.coversStart, round!.coversEnd]).toEqual(['2027-01-10', '2028-01-08']);
      expect([round!.opensOn, round!.closesOn]).toEqual(['2026-09-01', '2026-09-30']);
      expect(round!.offPerDay).toEqual({ RN: 2, LPN: 1, CNA: 1 });
      expect(round!.maxAwardsPerNurse).toBe(5);
      // TODAY (24 September) falls inside the window, so bidding is still open. A seeding on or
      // after 1 October would close it; either way awarding is the manager's step.
      expect(round!.status).toBe('open');
      expect(round!.awardedAt).toBeUndefined();
    });

    it('has about half the staff bidding one to five one-week choices inside the leave year', () => {
      const round = listLeaveBidRounds(db(), f.result.unitId)[0]!;
      const bids = listLeaveBids(db(), round.id);
      expect(bids.length / employees().length).toBeGreaterThan(0.3);
      expect(bids.length / employees().length).toBeLessThan(0.7);
      const bidders = new Set(employees().map((n) => n.id));
      for (const bid of bids) {
        expect(bidders.has(bid.nurseId)).toBe(true);
        expect(bid.enteredBy).toBe('manager');
        expect(bid.choices.length).toBeGreaterThanOrEqual(1);
        expect(bid.choices.length).toBeLessThanOrEqual(5);
        for (const c of bid.choices) {
          // Sunday to Saturday: weekday 0 and 6 days on.
          expect(weekdayOf(c.startDate)).toBe(0);
          expect(daysBetween(c.startDate, c.endDate)).toBe(6);
          expect(c.startDate >= round.coversStart && c.endDate <= round.coversEnd).toBe(true);
        }
      }
    });
  });

  realisticDemoChecks(f, 'va-sf-med-surg', TODAY);
});
