import { beforeEach, describe, expect, it } from 'vitest';

import { DemandTable } from '../acuity/demand.js';
import type { Assignment, FairnessLedgerEntry, Nurse, Preference } from '../domain/entities.js';
import { dateInRange, isoDate } from '../domain/time.js';
import { ALL_RULES, buildRuleContext, evaluateSchedule } from '../rules/registry.js';
import type { Violation } from '../rules/types.js';
import { ScheduleView } from '../schedule/view.js';
import {
  assign,
  coverageAllWeek,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  testUnit,
  timeOff,
} from '../testing/fixtures.js';
import { Rng } from './rng.js';
import { solve } from './solver.js';
import type { SolveInput, SolveOptions, SolveProgress, SolveReport } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const QUICK: SolveOptions = { seed: 1, maxIterations: 1500 };

/** A two-shift 12-hour unit with `rnPerShift` RNs required day and night, every day. */
function twelveHourUnit(
  nurses: Nurse[],
  rnPerShift: number,
  extra: Partial<SolveScenarioOptions> = {},
): SolveInput {
  return solveInputFrom({
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', rnPerShift),
      ...coverageAllWeek(NIGHT_12, 'RN', rnPerShift),
    ],
    ...extra,
  });
}

function fullTimers(count: number, overrides: Partial<Nurse> = {}): Nurse[] {
  return Array.from({ length: count }, (_, i) =>
    makeNurse({ isChargeEligible: i % 2 === 0, ...overrides }),
  );
}

const NURSE_SCOPE_IDS = new Set(ALL_RULES.filter((r) => r.scope === 'nurse').map((r) => r.id));

/** Hard violations a nurse's own timeline is responsible for — the ones the solver must never emit. */
function nurseScopeHard(report: SolveReport): Violation[] {
  return report.hardViolations.filter(
    (v) => NURSE_SCOPE_IDS.has(v.ruleId) && v.code !== 'under_contracted_hours',
  );
}

/** Re-judge a report with the full engine, independently of what the solver claims. */
function rejudge(input: SolveInput, report: SolveReport): Violation[] {
  const ctx = buildRuleContext({
    unit: input.unit,
    demand: new DemandTable(input.demand),
    nurses: input.nurses,
    shiftTypes: input.shiftTypes,
    timeOff: input.timeOff,
    credentials: input.credentials,
    nurseCredentials: input.nurseCredentials,
    shiftCredentialRequirements: input.shiftCredentialRequirements,
    holidays: input.holidays,
    weekendDefinition: input.ruleSet.weekendDefinition,
  });
  const view = new ScheduleView({
    period: input.period,
    assignments: report.assignments,
    priorAssignments: input.priorAssignments,
    nurses: input.nurses,
    shiftTypes: input.shiftTypes,
  });
  return evaluateSchedule(view, input.ruleSet, ctx).hardViolations;
}

function countBy<K>(items: readonly Assignment[], key: (a: Assignment) => K): Map<K, number> {
  const out = new Map<K, number>();
  for (const a of items) out.set(key(a), (out.get(key(a)) ?? 0) + 1);
  return out;
}

describe('a unit the roster can cover', () => {
  // 14 days × 2 shifts × 2 RNs = 56 nurse-shifts; ten 72h full-timers can give 60.
  const input = () =>
    twelveHourUnit(fullTimers(10), 2, {
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
    });

  it('fills every floor and breaks no hard rule', () => {
    const report = solve(input(), QUICK);
    expect(report.unfilled).toEqual([]);
    expect(report.hardViolations).toEqual([]);
  });

  it('gets every full-timer to their contracted hours', () => {
    const i = input();
    const report = solve(i, QUICK);
    const hours = new Map<string, number>();
    for (const a of report.assignments) {
      hours.set(a.nurseId, (hours.get(a.nurseId) ?? 0) + 12);
    }
    for (const nurse of i.nurses) {
      expect(hours.get(nurse.id), nurse.id).toBe(72);
    }
  });

  it('designates exactly one charge nurse on every staffed shift', () => {
    const report = solve(input(), QUICK);
    const charges = countBy(
      report.assignments.filter((a) => a.isCharge),
      (a) => `${a.date}::${a.shiftTypeId}`,
    );
    const staffed = countBy(report.assignments, (a) => `${a.date}::${a.shiftTypeId}`);
    expect(staffed.size).toBe(28);
    for (const key of staffed.keys()) expect(charges.get(key), key).toBe(1);
  });

  it('marks everything it creates as solver output', () => {
    const report = solve(input(), QUICK);
    expect(report.assignments.every((a) => a.source === 'solver')).toBe(true);
    expect(report.assignments.every((a) => !a.isOvertime && !a.isLocked)).toBe(true);
  });

  it('agrees with an independent full-engine evaluation of its own output', () => {
    const i = input();
    const report = solve(i, QUICK);
    expect(rejudge(i, report)).toEqual([]);
  });
});

describe('a short-staffed unit', () => {
  it('names every shortfall instead of failing, and still breaks no nurse-level rule', () => {
    // Three RNs cannot staff 3 per shift, day and night, for two weeks.
    const input = twelveHourUnit(fullTimers(3), 3);
    const report = solve(input, QUICK);
    expect(report.unfilled.length).toBeGreaterThan(0);
    for (const slot of report.unfilled) {
      expect(slot.shortfall).toBe(slot.required - slot.staffed);
      expect(slot.shortfall).toBeGreaterThan(0);
    }
    expect(nurseScopeHard(report)).toEqual([]);
  });

  it('reports the same shortfalls the coverage rule would', () => {
    const input = twelveHourUnit(fullTimers(3), 3);
    const report = solve(input, QUICK);
    const understaffed = rejudge(input, report).filter((v) => v.code === 'understaffed');
    expect(report.unfilled).toHaveLength(understaffed.length);
  });
});

describe('locks, leave and the lookback tail', () => {
  it('keeps a locked assignment exactly where the manager pinned it', () => {
    const nurses = fullTimers(6);
    const pinned = assign(nurses[3]!.id, NIGHT_12, '2026-01-10', {
      id: 'pinned',
      isLocked: true,
      isCharge: true,
      notes: 'requested',
    });
    const input = twelveHourUnit(nurses, 1, { assignments: [pinned] });
    const report = solve(input, QUICK);
    const kept = report.assignments.find((a) => a.id === 'pinned');
    expect(kept).toEqual(pinned);
    // And it is not duplicated by a solver copy of the same cell.
    const sameCell = report.assignments.filter(
      (a) => a.nurseId === pinned.nurseId && a.date === pinned.date,
    );
    expect(sameCell).toHaveLength(1);
  });

  it('throws away the previous unlocked draft rather than building on it', () => {
    const nurses = fullTimers(6);
    const stale = assign(nurses[0]!.id, DAY_12, '2026-01-05', { id: 'stale' });
    const input = twelveHourUnit(nurses, 1, { assignments: [stale] });
    const report = solve(input, QUICK);
    expect(report.assignments.some((a) => a.id === 'stale')).toBe(false);
  });

  it('never schedules a nurse during approved leave', () => {
    const nurses = fullTimers(6);
    const away = nurses[1]!;
    const input = twelveHourUnit(nurses, 1, {
      timeOff: [timeOff(away.id, '2026-01-06', '2026-01-12')],
    });
    const report = solve(input, QUICK);
    const mine = report.assignments.filter((a) => a.nurseId === away.id);
    const during = mine.filter((a) =>
      dateInRange(a.date, isoDate('2026-01-06'), isoDate('2026-01-12')),
    );
    expect(during).toEqual([]);
    // The night before leave runs into its first morning, so that one is off-limits too.
    const eve = mine.find((a) => a.date === '2026-01-05' && a.shiftTypeId === NIGHT_12.id);
    expect(eve).toBeUndefined();
  });

  it('respects rest owed from the last shift of the previous period', () => {
    const nurses = fullTimers(6);
    const tired = nurses[0]!;
    // Worked the night before the period starts: ends 07:00 on the 4th.
    const prior = assign(tired.id, NIGHT_12, '2026-01-03', { id: 'prior', periodId: 'prev' });
    const input = twelveHourUnit(nurses, 1, { priorAssignments: [prior] });
    const report = solve(input, QUICK);
    const firstDay = report.assignments.find(
      (a) => a.nurseId === tired.id && a.date === '2026-01-04' && a.shiftTypeId === DAY_12.id,
    );
    expect(firstDay).toBeUndefined();
    expect(nurseScopeHard(report)).toEqual([]);
  });
});

describe('fairness and preferences in the objective', () => {
  function history(nurseId: string, nights: number): FairnessLedgerEntry {
    return {
      id: `ledger-${nurseId}`,
      nurseId,
      periodId: 'prev',
      periodStart: isoDate('2025-12-21'),
      nightShifts: nights,
      weekendsWorked: 2,
      holidaysWorked: 0,
      onCallShifts: 0,
      undesirableShifts: 0,
      requestsApproved: 0,
      requestsDenied: 0,
      callOutsCovered: 0,
      totalHours: 72,
      overtimeHours: 0,
      preferenceHitRate: 1,
    };
  }

  it('hands the nights to the nurse who has carried the fewest', () => {
    const [a, b] = fullTimers(2, { isChargeEligible: true });
    // Two RNs, one day and one night slot: 12 nights to share. A carried them all last period.
    const input = twelveHourUnit([a!, b!], 1, {
      ledgerHistory: [history(a!.id, 6), history(b!.id, 0)],
    });
    const report = solve(input, QUICK);
    const nights = countBy(
      report.assignments.filter((x) => x.shiftTypeId === NIGHT_12.id),
      (x) => x.nurseId,
    );
    expect(nights.get(b!.id) ?? 0).toBeGreaterThan(nights.get(a!.id) ?? 0);
  });

  it('steers nights away from a nurse who asked to avoid them', () => {
    const [a, b, c] = fullTimers(3, { isChargeEligible: true });
    const avoidNights: Preference = {
      id: 'pref-1',
      nurseId: a!.id,
      kind: 'avoid_shift_type',
      shiftTypeId: NIGHT_12.id,
      weight: 5,
    };
    const input = twelveHourUnit([a!, b!, c!], 1, { preferences: [avoidNights] });
    const report = solve(input, QUICK);
    const nights = countBy(
      report.assignments.filter((x) => x.shiftTypeId === NIGHT_12.id),
      (x) => x.nurseId,
    );
    const aNights = nights.get(a!.id) ?? 0;
    expect(aNights).toBeLessThan(nights.get(b!.id) ?? 0);
    expect(aNights).toBeLessThan(nights.get(c!.id) ?? 0);
  });

  it('reports fairness scores for every nurse alongside the schedule', () => {
    const input = twelveHourUnit(fullTimers(4), 1);
    const report = solve(input, QUICK);
    expect(report.fairness.scores.map((s) => s.nurseId).sort()).toEqual(
      input.nurses.map((n) => n.id).sort(),
    );
  });
});

describe('cost', () => {
  it('prices the result when pay data is supplied, and not otherwise', () => {
    const nurses = fullTimers(6);
    const withoutPay = solve(twelveHourUnit(nurses, 1), QUICK);
    expect(withoutPay.cost).toBeUndefined();
    expect(withoutPay.objective.cost).toBe(0);

    resetFixtureCounters();
    const input = twelveHourUnit(fullTimers(6), 1, {
      cost: {
        payRates: [
          {
            id: 'rate-rn',
            nurseId: null,
            role: 'RN',
            hourlyRate: 50,
            effectiveFrom: isoDate('2025-01-01'),
          },
        ],
        differentials: [],
        overtimeRules: [],
      },
    });
    const withPay = solve(input, QUICK);
    // 28 shifts × 12h × $50, plus whatever extra shifts fill contracted hours, all at $600 each.
    expect(withPay.cost?.totals.total).toBe(withPay.assignments.length * 600);
    expect(withPay.cost?.unpricedAssignments).toBe(0);
    expect(withPay.objective.cost).toBeGreaterThan(0);
  });

  it('prefers the cheaper of two otherwise-equal nurses', () => {
    const [cheap, dear] = fullTimers(2, { isChargeEligible: true });
    // Eight-hour days: the 40h overtime threshold allows five a week, and five-in-a-row then
    // two off fits fourteen days exactly, so the cheaper nurse can take ten of the fourteen.
    const input = solveInputFrom({
      shiftTypes: [DAY_8],
      coverageRequirements: coverageAllWeek(DAY_8, 'RN', 1),
      // Both nurses are exempt from the hours floor, so only cost separates them per shift.
      nurses: [
        { ...cheap!, employmentType: 'per_diem', contractedHoursPerPeriod: 0 },
        { ...dear!, employmentType: 'per_diem', contractedHoursPerPeriod: 0 },
      ],
      cost: {
        payRates: [
          {
            id: 'r1',
            nurseId: cheap!.id,
            role: null,
            hourlyRate: 40,
            effectiveFrom: isoDate('2025-01-01'),
          },
          {
            id: 'r2',
            nurseId: dear!.id,
            role: null,
            hourlyRate: 90,
            effectiveFrom: isoDate('2025-01-01'),
          },
        ],
        differentials: [],
        overtimeRules: [],
      },
    });
    const report = solve(input, QUICK);
    const shifts = countBy(report.assignments, (a) => a.nurseId);
    expect(shifts.get(cheap!.id) ?? 0).toBeGreaterThan(shifts.get(dear!.id) ?? 0);
  });
});

describe('determinism, progress and cancellation', () => {
  it('re-running unchanged inputs with the same seed produces the identical schedule', () => {
    const first = solve(twelveHourUnit(fullTimers(10), 2), { seed: 42, maxIterations: 3000 });
    resetFixtureCounters();
    const second = solve(twelveHourUnit(fullTimers(10), 2), { seed: 42, maxIterations: 3000 });
    expect(second.assignments).toEqual(first.assignments);
    expect(second.objective).toEqual(first.objective);
    expect(second.stats.iterations).toBe(first.stats.iterations);
  });

  it('a different seed still yields a legal schedule', () => {
    const report = solve(twelveHourUnit(fullTimers(10), 2), { seed: 7, maxIterations: 1500 });
    expect(report.unfilled).toEqual([]);
    expect(nurseScopeHard(report)).toEqual([]);
  });

  it('annealing never makes the seed worse', () => {
    const report = solve(twelveHourUnit(fullTimers(10), 2), QUICK);
    expect(report.objective.total).toBeLessThanOrEqual(report.stats.seedObjective);
  });

  it('reports monotone progress from seeding through to a finished run', () => {
    const seen: SolveProgress[] = [];
    solve(twelveHourUnit(fullTimers(6), 1), {
      ...QUICK,
      progressEveryIterations: 250,
      onProgress: (p) => seen.push({ ...p }),
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[0]?.phase).toBe('seeding');
    expect(seen.at(-1)?.phase).toBe('finishing');
    expect(seen.at(-1)?.fraction).toBe(1);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.fraction).toBeGreaterThanOrEqual(seen[i - 1]!.fraction);
      expect(seen[i]!.best).toBeLessThanOrEqual(seen[i - 1]!.best);
    }
  });

  it('stops when cancelled and still hands back a legal schedule', () => {
    let polls = 0;
    const report = solve(twelveHourUnit(fullTimers(6), 1), {
      seed: 1,
      maxIterations: 50_000,
      shouldCancel: () => ++polls > 3,
    });
    expect(report.stats.cancelled).toBe(true);
    expect(report.stats.iterations).toBeLessThan(50_000);
    expect(nurseScopeHard(report)).toEqual([]);
  });

  it('honours a wall-clock limit using the injected clock', () => {
    let tick = 0;
    const report = solve(twelveHourUnit(fullTimers(6), 1), {
      seed: 1,
      maxIterations: 50_000,
      timeLimitMs: 1000,
      now: () => (tick += 50),
    });
    expect(report.stats.timedOut).toBe(true);
    expect(report.stats.iterations).toBeLessThan(50_000);
  });
});

describe('property: random units', () => {
  const SHIFT_SETS = [
    [DAY_12, NIGHT_12],
    [DAY_8, EVENING_8, NIGHT_8],
    [DAY_12, NIGHT_12, DAY_8],
  ];

  function randomInput(rng: Rng): SolveInput {
    const shiftTypes = rng.pick(SHIFT_SETS);
    const nurses: Nurse[] = [];
    const count = rng.nextInt(4, 12);
    for (let i = 0; i < count; i++) {
      const role = rng.chance(0.75) ? 'RN' : rng.chance(0.5) ? 'LPN' : 'CNA';
      const perDiem = rng.chance(0.15);
      const fte = perDiem ? 0 : rng.pick([1, 1, 1, 0.8, 0.6, 0.5]);
      nurses.push(
        makeNurse({
          role,
          employmentType: perDiem ? 'per_diem' : fte === 1 ? 'full_time' : 'part_time',
          fte,
          contractedHoursPerPeriod: Math.round(fte * 72),
          isChargeEligible: role === 'RN' && rng.chance(0.5),
          isNovice: rng.chance(0.2),
        }),
      );
    }
    const coverageRequirements = shiftTypes.flatMap((st) => [
      ...coverageAllWeek(st, 'RN', rng.nextInt(1, 3), rng.nextInt(2, 4)),
      ...(rng.chance(0.3) ? coverageAllWeek(st, 'LPN', 1) : []),
    ]);
    const leave = nurses
      .filter(() => rng.chance(0.25))
      .map((n) => {
        const start = rng.nextInt(4, 14);
        return timeOff(
          n.id,
          `2026-01-${String(start).padStart(2, '0')}`,
          `2026-01-${String(start + 2).padStart(2, '0')}`,
        );
      });
    const prior = nurses
      .filter(() => rng.chance(0.3))
      .map((n, i) =>
        assign(n.id, rng.pick(shiftTypes), '2026-01-03', { id: `prior-${i}`, periodId: 'prev' }),
      );
    return solveInputFrom({
      nurses,
      shiftTypes,
      coverageRequirements,
      timeOff: leave,
      priorAssignments: prior,
      unit: testUnit,
    });
  }

  it('never emits a nurse-level hard violation, and every remaining floor gap is reported', () => {
    const rng = new Rng(2026);
    for (let trial = 0; trial < 12; trial++) {
      resetFixtureCounters();
      const input = randomInput(rng);
      const report = solve(input, { seed: trial, maxIterations: 400 });

      expect(nurseScopeHard(report), `trial ${trial}`).toEqual([]);
      // No double-booking of a cell, ever.
      const cells = new Set(
        report.assignments.map((a) => `${a.nurseId}|${a.date}|${a.shiftTypeId}`),
      );
      expect(cells.size).toBe(report.assignments.length);

      const independent = rejudge(input, report);
      const shortfalls = independent.filter(
        (v) => v.code === 'understaffed' || v.code === 'ratio_breach',
      );
      expect(report.unfilled.length, `trial ${trial}`).toBe(shortfalls.length);
      expect(
        independent.filter(
          (v) => NURSE_SCOPE_IDS.has(v.ruleId) && v.code !== 'under_contracted_hours',
        ),
        `trial ${trial} (independent)`,
      ).toEqual([]);
    }
  });

  it('is reproducible across seeds of the generator itself', () => {
    const a = solve(randomInput(new Rng(99)), { seed: 5, maxIterations: 300 });
    resetFixtureCounters();
    const b = solve(randomInput(new Rng(99)), { seed: 5, maxIterations: 300 });
    expect(b.assignments).toEqual(a.assignments);
  });
});
