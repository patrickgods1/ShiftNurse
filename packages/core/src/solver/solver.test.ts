import { beforeEach, describe, expect, it } from 'vitest';

import { DemandTable } from '../acuity/demand.js';
import type {
  Assignment,
  CoverageRequirement,
  FairnessLedgerEntry,
  Nurse,
  Preference,
  ShiftType,
} from '../domain/entities.js';
import { addDays, dateInRange, datesInRange, isoDate } from '../domain/time.js';
import {
  ALL_RULES,
  buildRuleContext,
  defaultRuleSet,
  evaluateSchedule,
  hardRuleIdsByScope,
} from '../rules/registry.js';
import type { Violation } from '../rules/types.js';
import { AMOUNT_EPSILON, violationKey } from '../rules/violation-diff.js';
import { ScheduleView } from '../schedule/view.js';
import {
  assign,
  census,
  coverage,
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
  TIER_ROUTINE,
  testUnit,
  timeOff,
  UNIT_ID,
  withRuleParams,
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

/**
 * A per-diem nurse alone on a two-week unit, with only the consecutive-days rule able to bind:
 * no contract to run past, and a weekly cap above seven 12s.
 */
function adaAlone(
  shiftTypes: ShiftType[],
  locked: Assignment[],
  coverageRequirements: CoverageRequirement[],
): SolveInput {
  return solveInputFrom({
    nurses: [
      makeNurse({
        id: 'ada',
        employmentType: 'per_diem',
        fte: 0,
        contractedHoursPerPeriod: 0,
        isChargeEligible: true,
      }),
    ],
    shiftTypes,
    coverageRequirements,
    ruleSet: withRuleParams(defaultRuleSet(UNIT_ID), {
      'max-hours-per-week': { maxHoursPerWeek: 84, overtimeThresholdHours: 84 },
    }),
    assignments: locked,
  });
}

/** Ada's locked run, ids `${prefix}0`, `${prefix}1`, … */
function lockedAda(type: ShiftType, start: string, days: number, prefix: string): Assignment[] {
  return Array.from({ length: days }, (_, i) =>
    assign('ada', type, addDays(isoDate(start), i), { id: `${prefix}${i}`, isLocked: true }),
  );
}

/** The engine's rule context for an input, as the grid builds it. */
function contextOf(input: SolveInput) {
  return buildRuleContext({
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
}

/** Re-judge a report with the full engine, independently of what the solver claims. */
function rejudge(input: SolveInput, report: SolveReport): Violation[] {
  const ctx = contextOf(input);
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

describe('a unit whose charge nurse takes no patients', () => {
  // 10 routine patients on every day shift at 1:5 is 2 bedside RNs; the charge nurse is a third.
  // Floors ask for 2 a shift, so only the ratio setting can explain a third RN on days.
  const input = (nurses: Nurse[], chargeNurseTakesPatients: boolean) =>
    twelveHourUnit(nurses, 2, {
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      censusForecasts: Array.from({ length: 14 }, (_, d) =>
        census(addDays(isoDate('2026-01-04'), d), DAY_12, { [TIER_ROUTINE.id]: 10 }),
      ),
      ratioStaffing: {
        chargeNurseTakesPatients,
        breakMinutesPerNurse: 0,
        chargeCoversBreaks: false,
      },
    });
  const dayCounts = (report: SolveReport) => [
    ...countBy(
      report.assignments.filter((a) => a.shiftTypeId === DAY_12.id),
      (a) => a.date,
    ).values(),
  ];

  it('puts a third RN on every day shift so two are free for the patients', () => {
    const unit = input(fullTimers(14), false);
    const report = solve(unit, QUICK);
    expect(report.unfilled).toEqual([]);
    expect(dayCounts(report).every((n) => n >= 3)).toBe(true);
    expect(rejudge(unit, report).filter((v) => v.code === 'ratio_breach')).toEqual([]);
  });

  it('judges a day shift of two short, where a charge nurse with patients would do', () => {
    // The same roster solved as if the charge nurse took patients, then judged as if she does not.
    const nurses = fullTimers(14);
    const twoADay = solve(input(nurses, true), QUICK);
    const breaches = rejudge(input(nurses, false), twoADay).filter(
      (v) => v.code === 'ratio_breach',
    );
    const daysWithTwo = dayCounts(twoADay).filter((n) => n === 2).length;
    expect(daysWithTwo).toBeGreaterThan(0);
    expect(breaches).toHaveLength(daysWithTwo);
  });
});

describe('a unit whose ratio counts licensed nurses', () => {
  it('fills each day shift to four licensed nurses, two of them RNs, with LVNs', () => {
    // 20 patients every day shift at a licensed 1:5, half RNs: 4 licensed, at least 2 RNs. Ten
    // full-timers give 60 RN shifts against the 42 the RN minimums need (2 a day, 1 a night),
    // short of the 70 the pool and the nights take, so per-diem LVNs, whom only the pool calls
    // for, must fill the rest.
    const nurses = [
      ...fullTimers(10),
      // Per diem, so no contracted hours pull them onto shifts: only the pool can.
      ...Array.from({ length: 8 }, () =>
        makeNurse({ role: 'LPN', employmentType: 'per_diem', contractedHoursPerPeriod: 0 }),
      ),
    ];
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses,
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(NIGHT_12, 'RN', 1),
      ],
      ratioRules: [
        {
          id: 'lic',
          unitId: 'unit-1',
          role: 'licensed',
          acuityTierId: null,
          maxPatientsPerNurse: 5,
          minRnShare: 0.5,
          active: true,
        },
      ],
      censusForecasts: Array.from({ length: 14 }, (_, d) =>
        census(addDays(isoDate('2026-01-04'), d), DAY_12, { [TIER_ROUTINE.id]: 20 }),
      ),
    });
    const report = solve(input, QUICK);
    expect(report.unfilled).toEqual([]);
    expect(rejudge(input, report).filter((v) => v.code === 'ratio_breach')).toEqual([]);
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

  it('spreads a shortage it cannot avoid rather than stripping one shift', () => {
    // Two nurses, two day 12s with floors of two (Mon 5 and Wed 7 Jan), and a 12-hour week, so
    // each nurse works one of them. Both on Monday leaves Wednesday two short (3,000 + 6,000);
    // one each leaves both one short (3,000 twice), so Generate puts one nurse on each.
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: ['ada', 'bo'].map((id) =>
        makeNurse({
          id,
          isChargeEligible: true,
          employmentType: 'per_diem',
          contractedHoursPerPeriod: 0,
        }),
      ),
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        coverage(DAY_12, 'RN', 2, 2, null, isoDate('2026-01-05')),
        coverage(DAY_12, 'RN', 2, 2, null, isoDate('2026-01-07')),
      ],
      ruleSet: withRuleParams(defaultRuleSet(UNIT_ID), {
        'max-hours-per-week': { maxHoursPerWeek: 12, overtimeThresholdHours: 12 },
      }),
    });
    const report = solve(input, { seed: 1, maxIterations: 1500 });
    const on = (date: string) =>
      report.assignments.filter((a) => a.date === date).map((a) => a.nurseId);
    expect(on('2026-01-05')).toHaveLength(1);
    expect(on('2026-01-07')).toHaveLength(1);
    expect([...on('2026-01-05'), ...on('2026-01-07')].sort()).toEqual(['ada', 'bo']);
  });

  it('moves a day nurse onto the night when the night is further short', () => {
    // Monday 5 Jan wants two RNs on the day 12 and two on the night, and a 12-hour week lets each
    // nurse work one shift. Both on the day leaves the night two short (3,000 + 6,000); one on
    // each leaves both one short (3,000 twice), so Generate sends one of them to the night.
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: ['ada', 'bo'].map((id) =>
        makeNurse({
          id,
          isChargeEligible: true,
          employmentType: 'per_diem',
          contractedHoursPerPeriod: 0,
        }),
      ),
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        coverage(DAY_12, 'RN', 2, 2, null, isoDate('2026-01-05')),
        coverage(NIGHT_12, 'RN', 2, 2, null, isoDate('2026-01-05')),
      ],
      ruleSet: withRuleParams(defaultRuleSet(UNIT_ID), {
        'max-hours-per-week': { maxHoursPerWeek: 12, overtimeThresholdHours: 12 },
      }),
    });
    const report = solve(input, { seed: 1, maxIterations: 1500 });
    const on = (type: ShiftType) =>
      report.assignments
        .filter((a) => a.date === '2026-01-05' && a.shiftTypeId === type.id)
        .map((a) => a.nurseId);
    expect(on(DAY_12)).toHaveLength(1);
    expect(on(NIGHT_12)).toHaveLength(1);
    expect([...on(DAY_12), ...on(NIGHT_12)].sort()).toEqual(['ada', 'bo']);
  });

  it('never moves a nurse onto a night that leaves her no rest before a locked day', () => {
    // As above, but with a 24-hour week and Ada locked on Tuesday's day 12 (07:00). Monday's night
    // ends at 07:00 Tuesday — no rest at all against the 10 hours owed — so of the two only Bo
    // can take the night: Ada on Monday's day and Bo on the night, each shift one short.
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: ['ada', 'bo'].map((id) =>
        makeNurse({
          id,
          isChargeEligible: true,
          employmentType: 'per_diem',
          contractedHoursPerPeriod: 0,
        }),
      ),
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        coverage(DAY_12, 'RN', 2, 2, null, isoDate('2026-01-05')),
        coverage(NIGHT_12, 'RN', 2, 2, null, isoDate('2026-01-05')),
      ],
      ruleSet: withRuleParams(defaultRuleSet(UNIT_ID), {
        'max-hours-per-week': { maxHoursPerWeek: 24, overtimeThresholdHours: 24 },
      }),
      assignments: [
        assign('ada', DAY_12, '2026-01-06', { id: 'tue', isLocked: true, isCharge: true }),
      ],
    });
    for (const seed of [1, 2, 3]) {
      const report = solve(input, { seed, maxIterations: 1500 });
      const monday = (type: ShiftType) =>
        report.assignments
          .filter((a) => a.date === '2026-01-05' && a.shiftTypeId === type.id)
          .map((a) => a.nurseId);
      expect(monday(NIGHT_12)).not.toContain('ada');
      expect(monday(DAY_12)).toEqual(['ada']);
      expect(monday(NIGHT_12)).toEqual(['bo']);
      expect(nurseScopeHard(report)).toEqual([]);
    }
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
  });

  it('does not schedule a nurse back from a paid vacation up to a full pay period of work', () => {
    // A unit that needs more hours than its staff have: the solver fills everyone to the top
    // of their contract. Paid leave counts toward it, so the vacationer's ceiling is
    // 72 contracted + 4 tolerance − 36 paid leave = 40 worked hours: three 12s, not six.
    const nurses = fullTimers(6, { contractedHoursPerPeriod: 72 });
    const away = nurses[1]!;
    const input = twelveHourUnit(nurses, 3, {
      timeOff: [timeOff(away.id, '2026-01-04', '2026-01-10', { paidHours: 36 })],
    });
    const report = solve(input, QUICK);
    const hours = report.assignments.filter((a) => a.nurseId === away.id).length * 12;
    expect(hours).toBeLessThanOrEqual(40);
    expect(hours).toBeGreaterThan(0);
    expect(rejudge(input, report).filter((v) => v.code === 'over_contracted_hours')).toEqual([]);
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

  it('never adds a day to a locked run that is already too long', () => {
    // Mon 5 – Sat 10 locked: six days against a cap of five.
    const locked = lockedAda(DAY_8, '2026-01-05', 6, 'L');
    const input = adaAlone([DAY_8], locked, [
      coverage(DAY_8, 'RN', 1, 1, null, isoDate('2026-01-04')),
      coverage(DAY_8, 'RN', 1, 1, null, isoDate('2026-01-11')),
      coverage(DAY_8, 'RN', 1, 1, null, isoDate('2026-01-12')),
    ]);
    const report = solve(input, { seed: 1, maxIterations: 2000 });
    const added = report.assignments.filter((a) => !a.isLocked).map((a) => a.date);
    // Sun 4 and Sun 11 make the run seven days; Mon 12 is only one day off after it, two owed.
    expect(added).not.toContain('2026-01-04');
    expect(added).not.toContain('2026-01-11');
    expect(added).not.toContain('2026-01-12');
    const runs = report.hardViolations.filter((v) => v.code === 'too_many_consecutive_shifts');
    expect(runs).not.toEqual([]);
    for (const v of runs) expect(v.assignmentIds).toEqual(locked.map((a) => a.id));
  });

  it('keeps the locked run of five nights on the report instead of hiding it behind day shifts', () => {
    // Tue 6 – Sat 10 locked nights: five against a cap of three.
    const locked = lockedAda(NIGHT_12, '2026-01-06', 5, 'N');
    const input = adaAlone([DAY_12, NIGHT_12], locked, [
      coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-04')),
      coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-05')),
    ]);
    const report = solve(input, { seed: 1, maxIterations: 2000 });
    // Mon 5 joins the nights into a six-day run. Sun 4 alone, with Mon 5 off, is a legal shift.
    const added = report.assignments.filter((a) => !a.isLocked).map((a) => a.date);
    expect(added).not.toContain('2026-01-05');
    const nights = report.hardViolations.find((v) => v.code === 'too_many_consecutive_nights');
    expect(nights?.assignmentIds).toEqual(expect.arrayContaining(locked.map((a) => a.id)));
  });

  it("keeps a locked nurse's charge flag as the manager set it, and adds a charge nurse beside her", () => {
    // Saving a Generate never rewrites a locked row, so flagging the pin as charge here would
    // preview a charge nurse the saved grid does not have. The shift gets a second nurse instead.
    const nurses = Array.from({ length: 6 }, () =>
      makeNurse({
        employmentType: 'per_diem',
        contractedHoursPerPeriod: 0,
        isChargeEligible: true,
      }),
    );
    const pin = assign(nurses[0]!.id, DAY_12, '2026-01-07', {
      id: 'pin',
      isLocked: true,
      isCharge: false,
    });
    const input = solveInputFrom({
      nurses,
      shiftTypes: [DAY_12],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      assignments: [pin],
    });
    const report = solve(input, { seed: 1, maxIterations: 3000 });
    const wednesday = report.assignments.filter((a) => a.date === '2026-01-07');
    expect(wednesday).toHaveLength(2);
    expect(wednesday.find((a) => a.id === 'pin')).toEqual(pin);
    const other = wednesday.find((a) => a.id !== 'pin')!;
    expect(other.isLocked).toBe(false);
    expect(other.isCharge).toBe(true);
    expect(report.hardViolations).toEqual([]);
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
      periodDays: 14,
      availableDays: 14,
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
    const nA = nights.get(a!.id) ?? 0;
    const nB = nights.get(b!.id) ?? 0;
    expect(nB).toBeGreaterThan(nA);
    // The period starts 2026-01-04; last period's row (2025-12-21, 14 days) has its midpoint
    // 2025-12-28, 7 days back, so it weighs w = 0.5^(7/180) = 0.973404 and A carries 6w = 5.840426
    // nights into it. Same contract, both fully available: equal fair shares, so the nights term is
    // zero when 6w + nA = nB, i.e. nA = (N − 5.840426) / 2 for N nights in all.
    const total = nA + nB;
    expect(Math.abs(nA - (total - 5.840426) / 2)).toBeLessThanOrEqual(1);
  });

  it('gives less weight to nights a nurse carried half a year ago', () => {
    const [a, b] = fullTimers(2, { isChargeEligible: true });
    // Both nurses' only row is the fortnight from 2025-07-01: midpoint 2025-07-08, exactly 180
    // days before the period starts on 2026-01-04, so it weighs 0.5^(180/180) = 0.5. Same row
    // age, same contract, both fully available: equal fair shares. A's 6 nights count as 3, and
    // the nights term is |nA − (N − 3)/2| over N nights in all: at N = 5, nA = 1. Undecayed the
    // target would be (N − 6)/2, nA = 0 at N = 5; by the old 0.85-per-row weight (N − 5.1)/2, also
    // 0. From N = 5 up, 0.5 of tolerance tells the two apart.
    const halfYearAgo = { periodStart: isoDate('2025-07-01') };
    const input = twelveHourUnit([a!, b!], 1, {
      ledgerHistory: [
        { ...history(a!.id, 6), ...halfYearAgo },
        { ...history(b!.id, 0), ...halfYearAgo },
      ],
    });
    const report = solve(input, QUICK);
    const nights = countBy(
      report.assignments.filter((x) => x.shiftTypeId === NIGHT_12.id),
      (x) => x.nurseId,
    );
    const nA = nights.get(a!.id) ?? 0;
    const nB = nights.get(b!.id) ?? 0;
    expect(nA + nB).toBeGreaterThanOrEqual(5);
    expect(Math.abs(nA - (nA + nB - 3) / 2)).toBeLessThanOrEqual(0.5);
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

describe('incompatible staff', () => {
  /** A week of day 12s needing four RNs; ten RNs of three shifts each staff it, two kept apart. */
  function week(extra: Partial<SolveScenarioOptions> = {}): SolveInput {
    const nurses = fullTimers(10);
    return solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-10'),
      nurses,
      shiftTypes: [DAY_12],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 4),
      incompatibilityGroups: [
        {
          id: 'g1',
          unitId: testUnit.id,
          name: 'Keep apart',
          nurseIds: [nurses[0]!.id, nurses[1]!.id],
          maxTogether: 1,
          reason: 'test',
        },
      ],
      ...extra,
    });
  }

  function daysTogether(input: SolveInput, report: SolveReport): string[] {
    const [a, b] = input.incompatibilityGroups![0]!.nurseIds;
    const aDays = new Set(report.assignments.filter((x) => x.nurseId === a).map((x) => x.date));
    return report.assignments
      .filter((x) => x.nurseId === b && aDays.has(x.date))
      .map((x) => x.date);
  }

  it('never puts the two on the same day when there is someone else to send', () => {
    const input = week();
    const report = solve(input, QUICK);
    expect(report.unfilled).toEqual([]);
    expect(daysTogether(input, report)).toEqual([]);
    expect(report.softViolations.filter((v) => v.code === 'incompatible_staff_together')).toEqual(
      [],
    );
  });

  it('still gives both of them work', () => {
    const input = week();
    const report = solve(input, QUICK);
    const [a, b] = input.incompatibilityGroups![0]!.nurseIds;
    expect(report.assignments.filter((x) => x.nurseId === a).length).toBeGreaterThan(0);
    expect(report.assignments.filter((x) => x.nurseId === b).length).toBeGreaterThan(0);
  });

  it('gives the same schedule when run again on the same inputs', () => {
    const input = week();
    expect(solve(input, QUICK).assignments).toEqual(solve(input, QUICK).assignments);
  });

  it('pairs them only once the group has ended', () => {
    const input = week();
    const ended = {
      ...input,
      incompatibilityGroups: [
        { ...input.incompatibilityGroups![0]!, endsOn: isoDate('2026-01-03') },
      ],
    };
    // With the group ended nothing holds them apart, so the objective has no reason to.
    const report = solve(ended, QUICK);
    expect(report.softViolations.filter((v) => v.code === 'incompatible_staff_together')).toEqual(
      [],
    );
    expect(report.objective.incompatibility).toBe(0);
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

  it('hands back the best schedule it found, never a worse one it wandered to', () => {
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

  it('never lets Generate grow or trade a breach the locked shifts already carry', () => {
    const rng = new Rng(4049);
    let withBreachingPins = 0;
    for (let trial = 0; trial < 12; trial++) {
      resetFixtureCounters();
      const base = randomInput(rng);
      const dates = datesInRange(base.period.startDate, base.period.endDate);
      // No legality check: many of these pins break a hard rule on their own. Each nurse's pins
      // are a run of days, as a manager locks a stretch: scattered single days almost never
      // make a breach that one more day can grow, and that is the case this guards.
      const locks: Assignment[] = [];
      for (const n of base.nurses) {
        if (!rng.chance(0.35)) continue;
        const days = rng.nextInt(2, 6);
        const first = rng.nextInt(0, dates.length - days);
        for (const date of dates.slice(first, first + days)) {
          locks.push(
            assign(n.id, rng.pick(base.shiftTypes), date, {
              id: `lock-${trial}-${locks.length}`,
              isLocked: true,
            }),
          );
        }
      }
      const input: SolveInput = { ...base, assignments: locks };
      const report = solve(input, { seed: trial, maxIterations: 400 });

      // What the pins and the lookback tail break with nothing else on the schedule.
      const pinsAlone = new ScheduleView({
        period: input.period,
        assignments: locks,
        priorAssignments: input.priorAssignments,
        nurses: input.nurses,
        shiftTypes: input.shiftTypes,
      });
      const baseline = evaluateSchedule(pinsAlone, input.ruleSet, contextOf(input), {
        only: hardRuleIdsByScope(input.ruleSet, 'nurse'),
      }).hardViolations.filter((v) => v.code !== 'under_contracted_hours');
      if (baseline.length > 0) withBreachingPins++;

      const pinned = new Set([...locks, ...input.priorAssignments].map((a) => a.id));
      for (const v of nurseScopeHard(report)) {
        const where = `trial ${trial}: ${v.message}`;
        expect(
          v.assignmentIds.filter((id) => !pinned.has(id)),
          where,
        ).toEqual([]);
        expect(
          baseline.some(
            (b) => violationKey(b) === violationKey(v) && b.amount + AMOUNT_EPSILON >= v.amount,
          ),
          where,
        ).toBe(true);
      }
    }
    expect(withBreachingPins).toBeGreaterThanOrEqual(4);
  });

  it('builds the same random unit twice and solves it the same', () => {
    const a = solve(randomInput(new Rng(99)), { seed: 5, maxIterations: 300 });
    resetFixtureCounters();
    const b = solve(randomInput(new Rng(99)), { seed: 5, maxIterations: 300 });
    expect(b.assignments).toEqual(a.assignments);
  });
});
