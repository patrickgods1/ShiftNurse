/**
 * The solver model's incremental bookkeeping against the obvious, slow truth.
 *
 * `SolverModel` never recomputes the objective from scratch during a search: every add, remove
 * and undo nudges cached sums and counters, and the annealer trusts them to price each move.
 * A counter that drifts by one shift does not crash anything — it makes the search chase a
 * phantom improvement and hand back a schedule it believes is better than it is. So after a
 * long random walk of moves and undos, every cached term must equal what a model built fresh
 * from the same schedule computes, and every staffing count must equal a plain count of the
 * roster.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NURSE_ROLES } from '../acuity/demand.js';
import type { Assignment, Nurse, NurseRole, Preference } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { ALL_RULES, defaultRuleSet, evaluateSchedule } from '../rules/registry.js';
import { ScheduleView } from '../schedule/view.js';
import {
  assign,
  CRED_ACLS,
  census,
  coverageAllWeek,
  credentialRequirement,
  DAY_8,
  DAY_12,
  MID_8,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  resetFixtureCounters,
  solveInputFrom,
  TIER_ROUTINE,
  timeOff,
} from '../testing/fixtures.js';
import { SolverModel } from './model.js';
import { Rng } from './rng.js';
import { solve } from './solver.js';
import type { SolveInput } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/**
 * `mid`: add an 11:00–19:00 mid 8 inside the day 12, with an ACLS requirement on it.
 * `groups`: keep five of the staff apart (one the nurse with the lookback night, one an LPN), and
 * two more from the 8th, so the walk keeps pairing and parting incompatible nurses.
 */
function scenario({
  mid = false,
  groups = false,
  holidays = false,
  pending = false,
  weekends = false,
} = {}): SolveInput {
  const nurses: Nurse[] = [
    ...Array.from({ length: 8 }, (_, i) =>
      makeNurse({ isChargeEligible: i % 3 === 0, contractedHoursPerPeriod: i === 7 ? 0 : 72 }),
    ),
    makeNurse({ role: 'LPN' }),
    makeNurse({ role: 'LPN' }),
    makeNurse({ isNovice: true }),
  ];
  const preferences: Preference[] = [
    {
      id: 'p1',
      nurseId: nurses[0]!.id,
      kind: 'avoid_shift_type',
      shiftTypeId: NIGHT_12.id,
      weight: 4,
    },
    {
      id: 'p2',
      nurseId: nurses[1]!.id,
      kind: 'prefer_shift_type',
      shiftTypeId: NIGHT_12.id,
      weight: 3,
    },
    { id: 'p3', nurseId: nurses[2]!.id, kind: 'weekend_appetite', level: -1, weight: 2 },
  ];
  // One pin, so the rebuild has to carry a locked shift and the baseline it sets.
  const pinned = assign(nurses[3]!.id, DAY_12, '2026-01-06', { isLocked: true });
  // A night ending on the period's first morning, so the lookback tail is in play.
  const prior = assign(nurses[4]!.id, NIGHT_12, '2026-01-03', { periodId: 'prior' });
  // A weekend worked last period, so a run can start in the lookback tail.
  const priorWeekend = assign(nurses[1]!.id, DAY_12, '2025-12-27', { periodId: 'prior' });
  const base = defaultRuleSet('unit-1');
  // Every other weekend, at most one in the schedule (low, so the excess term fires too).
  const weekendRules = {
    ...base,
    configs: base.configs.map((c) =>
      c.ruleId === 'weekend-pattern'
        ? { ...c, enabled: true, params: { maxConsecutiveWeekends: 1, maxWeekendsPerPeriod: 1 } }
        : c,
    ),
  };
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 2, 3),
      ...coverageAllWeek(DAY_12, 'LPN', 0, 1),
      ...coverageAllWeek(NIGHT_12, 'RN', 2, 2),
      ...(mid ? coverageAllWeek(MID_8, 'RN', 1, 1) : []),
    ],
    ...(mid
      ? {
          shiftTypes: [DAY_12, NIGHT_12, MID_8],
          shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: MID_8 })],
          nurseCredentials: [nurseCredential(nurses[0]!.id, CRED_ACLS)],
        }
      : {}),
    preferences,
    ...(groups
      ? {
          incompatibilityGroups: [
            {
              id: 'g1',
              unitId: 'unit-1',
              name: 'Clique',
              nurseIds: [0, 1, 2, 4, 9].map((i) => nurses[i]!.id),
              maxTogether: 1,
              reason: 'test',
            },
            {
              id: 'g2',
              unitId: 'unit-1',
              name: 'Pair',
              nurseIds: [nurses[5]!.id, nurses[6]!.id],
              maxTogether: 1,
              reason: 'test',
              startsOn: isoDate('2026-01-08'),
            },
          ],
        }
      : {}),
    assignments: [pinned],
    priorAssignments: weekends ? [priorWeekend, prior] : [prior],
    ...(weekends ? { ruleSet: weekendRules } : {}),
    ...(pending
      ? {
          timeOff: [
            timeOff(nurses[0]!.id, '2026-01-06', '2026-01-08', { status: 'pending' }),
            timeOff(nurses[2]!.id, '2026-01-10', '2026-01-10', { status: 'pending' }),
          ],
        }
      : {}),
    holidays: [
      {
        id: 'h1',
        unitId: 'unit-1',
        date: isoDate('2026-01-08'),
        name: 'Test day',
        isMajor: false,
        pairedHolidayId: holidays ? 'winter-26' : null,
      },
      ...(holidays ? rotationHolidays() : []),
    ],
    ...(holidays
      ? {
          // Four nurses worked last year's Winter Day; the eve before the period pairs with
          // the period's first day, so the lookback night is half a pair.
          holidayWork: [0, 1, 2, 3].map((i) => ({
            holidayId: 'winter-25',
            nurseId: nurses[i]!.id,
          })),
          ruleParams: { 'holiday-rotation': { pairMinorWithMajor: true } },
        }
      : {}),
  });
}

function rotationHolidays() {
  const h = (id: string, date: string, name: string, isMajor: boolean, paired: string | null) => ({
    id,
    unitId: 'unit-1',
    date: isoDate(date),
    name,
    isMajor,
    pairedHolidayId: paired,
  });
  return [
    h('winter-25', '2025-01-09', 'Winter Day', true, null),
    h('winter-26', '2026-01-09', 'Winter Day', true, null),
    h('eve-26', '2026-01-03', 'First Eve', false, 'first-26'),
    h('first-26', '2026-01-04', 'First Day', true, null),
  ];
}

/** The same schedule, built the slow way: a fresh model, fed each shift's roster in order. */
function rebuild(input: SolveInput, model: SolverModel): SolverModel {
  const fresh = new SolverModel(input);
  for (const shift of model.shifts) {
    for (const a of model.roster(shift)) {
      if (!a.isLocked) fresh.add({ ...a, isCharge: false });
    }
  }
  return fresh;
}

function naiveStaffed(input: SolveInput, roster: readonly Assignment[], role: NurseRole): number {
  const roleOf = new Map(input.nurses.map((n) => [n.id, n.role]));
  return roster.filter((a) => roleOf.get(a.nurseId) === role).length;
}

describe('SolverModel bookkeeping', () => {
  it('prices a schedule the same after a long run of moves and undos as a fresh model does', () => {
    walk(scenario());
  });

  it('keeps a mid 8 priced right as the day 12 around it changes', () => {
    // The mid 8's new-grad and ACLS cover come from the day 12, so a move on the day 12 has to
    // re-price the mid 8 too — and an undo has to put its old price back.
    // Checked after every step: a stale mid 8 is often re-priced by its own next move.
    walk(scenario({ mid: true }), 1);
  });

  it('keeps the holiday rotation priced right as shifts land on and leave holidays', () => {
    // Nurses owed Winter Day off, a minor holiday paired with it, and a pair split across the
    // lookback tail: every add and undo on those dates moves the count.
    walk(scenario({ holidays: true }), 1);
  });

  it('prices each holiday-rotation breach at the holiday weight', () => {
    const input = scenario({ holidays: true });
    // Nurse 0 is owed Winter Day (the 9th, day 5) off and works it; nurse 4, on the lookback
    // night of First Eve, works First Day (the 4th, day 0), the major it is paired with.
    const place = (model: SolverModel) => {
      for (const [i, day] of [
        [0, 5],
        [4, 0],
      ] as const) {
        const n = model.nurseIdx.get(input.nurses[i]!.id)!;
        model.add(model.make(n, model.shiftAt(day, DAY_12)));
      }
      return model;
    };
    const priced = place(new SolverModel(input));
    const free = place(new SolverModel(input, { holidayRotation: 0 }));
    expect(priced.holidayBreaches()).toBe(2);
    // Two breaches at 55 points each; nothing else differs between the two models.
    expect(priced.breakdown().fairness - free.breakdown().fairness).toBeCloseTo(110, 6);
    expect(priced.objective() - free.objective()).toBeCloseTo(110, 6);
  });

  it('keeps weekend runs priced right as shifts land on and leave weekends', () => {
    walk(scenario({ weekends: true }), 1);
  });

  it('prices each weekend-pattern breach at the weekend weight', () => {
    const input = scenario({ weekends: true });
    // Nurse 1 worked Sat 27 Dec last period and works Sun 4 Jan (day 0): two in a row. Nurse 2
    // works Sat 10 (day 6) and Sat 17 Jan (day 13): two in a row again, and two weekends in a
    // schedule that allows one. Three breaches.
    const place = (model: SolverModel) => {
      for (const [i, day] of [
        [1, 0],
        [2, 6],
        [2, 13],
      ] as const) {
        const n = model.nurseIdx.get(input.nurses[i]!.id)!;
        model.add(model.make(n, model.shiftAt(day, DAY_12)));
      }
      return model;
    };
    const priced = place(new SolverModel(input));
    const free = place(new SolverModel(input, { weekendPattern: 0 }));
    expect(priced.weekendBreaches()).toBe(3);
    // Three breaches at 50 points each, in the fairness bucket.
    expect(priced.breakdown().fairness - free.breakdown().fairness).toBeCloseTo(150, 6);
    expect(priced.objective() - free.objective()).toBeCloseTo(150, 6);
  });

  it('keeps days asked off priced right as shifts land on and leave them', () => {
    walk(scenario({ pending: true }), 1);
  });

  it('prices each shift inside a pending request at the pending weight', () => {
    const input = scenario({ pending: true });
    // Nurse 0 asked for the 6th–8th (days 2–4) and nurse 2 for the 10th (day 6).
    const place = (model: SolverModel) => {
      for (const [i, day] of [
        [0, 2],
        [0, 4],
        [2, 6],
        [2, 7],
      ] as const) {
        const n = model.nurseIdx.get(input.nurses[i]!.id)!;
        model.add(model.make(n, model.shiftAt(day, DAY_12)));
      }
      return model;
    };
    const priced = place(new SolverModel(input));
    const free = place(new SolverModel(input, { pendingTimeOff: 0 }));
    // Three of the four land inside a request; the 11th (day 7) is after nurse 2's.
    expect(priced.pendingBreaches()).toBe(3);
    expect(priced.breakdown().preferences - free.breakdown().preferences).toBeCloseTo(240, 6);
    expect(priced.objective() - free.objective()).toBeCloseTo(240, 6);
  });

  it('prices each day shift too soon after nights at the recovery weight', () => {
    const input = scenario();
    // Nurse 4 comes off the lookback night of the 3rd and works the day of the 5th (day 1):
    // one day off. Nurse 0 works the night of the 7th (day 3) and the day of the 8th (day 4).
    const place = (model: SolverModel) => {
      for (const [i, day, st] of [
        [4, 1, DAY_12],
        [0, 3, NIGHT_12],
        [0, 4, DAY_12],
      ] as const) {
        const n = model.nurseIdx.get(input.nurses[i]!.id)!;
        model.add(model.make(n, model.shiftAt(day, st)));
      }
      return model;
    };
    const priced = place(new SolverModel(input));
    const free = place(new SolverModel(input, { nightRecovery: 0 }));
    expect(priced.recoveryBreaches()).toBe(2);
    // Two breaches at 45 points each, counted with preferences.
    expect(priced.breakdown().preferences - free.breakdown().preferences).toBeCloseTo(90, 6);
    expect(priced.objective() - free.objective()).toBeCloseTo(90, 6);
  });

  it('stops pricing the day shift once the night before it is taken away, and back on undo', () => {
    const input = scenario();
    const model = new SolverModel(input);
    const n = model.nurseIdx.get(input.nurses[0]!.id)!;
    const night = model.make(n, model.shiftAt(3, NIGHT_12));
    model.add(night);
    model.add(model.make(n, model.shiftAt(5, DAY_12)));
    expect(model.recoveryBreaches()).toBe(1);
    const token = model.remove(night);
    expect(model.recoveryBreaches()).toBe(0);
    model.undoRemove(night, token);
    expect(model.recoveryBreaches()).toBe(1);
  });

  it('keeps the price of incompatible nurses right as they are paired and parted', () => {
    // A change to the day 12 re-prices the hours the mid 8 shares with it, and the other way
    // round; checked every step for the same reason as the mid 8 above.
    const priced = walk(scenario({ mid: true, groups: true }), 1);
    expect(priced.incompatibility).toBeGreaterThan(0);
  });
});

/** Walks, checks, and returns the largest value each term reached, so a test can see it was exercised. */
function walk(input: SolveInput, checkEvery = 25): Record<string, number> {
  const peak: Record<string, number> = {};
  {
    const model = new SolverModel(input);
    const rng = new Rng(20260104);
    let checked = 0;

    for (let step = 1; step <= 600; step++) {
      if (model.unlocked.length === 0 || rng.chance(0.55)) {
        const shift = rng.pick(model.solvableShifts);
        const n = rng.pick(model.candidates);
        if (!model.eligible(n, shift, null)) continue;
        const a = model.make(n, shift);
        const token = model.add(a);
        if (rng.chance(0.3)) model.undoAdd(a, token);
      } else {
        const a = rng.pick(model.unlocked);
        const token = model.remove(a);
        if (rng.chance(0.3)) model.undoRemove(a, token);
      }

      if (step % checkEvery !== 0) continue;
      const fresh = rebuild(input, model);
      const got = model.breakdown();
      const want = fresh.breakdown();
      for (const [term, value] of Object.entries(got))
        peak[term] = Math.max(peak[term] ?? 0, value);
      for (const term of [
        'coverage',
        'incompatibility',
        'hours',
        'fairness',
        'preferences',
        'cost',
        'total',
      ] as const) {
        expect(got[term], `${term} after step ${step}`).toBeCloseTo(want[term], 6);
      }
      expect(model.objective()).toBeCloseTo(fresh.objective(), 6);
      for (const shift of model.shifts) {
        for (const role of NURSE_ROLES) {
          expect(model.staffed(shift, role)).toBe(naiveStaffed(input, model.roster(shift), role));
        }
      }
      expect(model.shortShifts().map((s) => s.idx)).toEqual(fresh.shortShifts().map((s) => s.idx));
      checked++;
    }

    // The walk must actually have built a schedule worth checking, not idled on ineligible picks.
    expect(checked).toBeGreaterThanOrEqual(Math.floor((0.9 * 600) / checkEvery));
    expect(model.unlocked.length).toBeGreaterThan(10);
  }
  return peak;
}

describe('holiday rotation in Generate', () => {
  function christmas(workedLastYear: string) {
    const ana = makeNurse({ id: 'ana', isChargeEligible: true, contractedHoursPerPeriod: 0 });
    const ben = makeNurse({ id: 'ben', isChargeEligible: true, contractedHoursPerPeriod: 0 });
    const h = (id: string, date: string) => ({
      id,
      unitId: 'unit-1',
      date: isoDate(date),
      name: 'Christmas Day',
      isMajor: true,
      pairedHolidayId: null,
    });
    return solveInputFrom({
      startDate: isoDate('2026-12-25'),
      endDate: isoDate('2026-12-25'),
      nurses: [ana, ben],
      shiftTypes: [DAY_12],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      holidays: [h('xmas-25', '2025-12-25'), h('xmas-26', '2026-12-25')],
      holidayWork: [{ holidayId: 'xmas-25', nurseId: workedLastYear }],
    });
  }

  it('gives Christmas to the nurse who had it off last year', () => {
    // Run both ways round, so the answer is the rotation and not roster order.
    for (const [worked, expected] of [
      ['ana', 'ben'],
      ['ben', 'ana'],
    ] as const) {
      const report = solve(christmas(worked), { seed: 1, maxIterations: 500 });
      expect(
        report.assignments.map((a) => a.nurseId),
        `${worked} worked last year`,
      ).toEqual([expected]);
    }
  });

  it('gives Thanksgiving to the nurse who did not work Memorial Day, when the unit pairs them', () => {
    const thanksgiving = (workedMemorialDay: string) =>
      solveInputFrom({
        startDate: isoDate('2026-11-26'),
        endDate: isoDate('2026-11-26'),
        nurses: [
          makeNurse({ id: 'ana', isChargeEligible: true, contractedHoursPerPeriod: 0 }),
          makeNurse({ id: 'ben', isChargeEligible: true, contractedHoursPerPeriod: 0 }),
        ],
        shiftTypes: [DAY_12],
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
        holidays: [
          {
            id: 'tg',
            unitId: 'unit-1',
            date: isoDate('2026-11-26'),
            name: 'Thanksgiving Day',
            isMajor: true,
            pairedHolidayId: null,
          },
          {
            id: 'mem',
            unitId: 'unit-1',
            date: isoDate('2026-05-25'),
            name: 'Memorial Day',
            isMajor: false,
            pairedHolidayId: 'tg',
          },
        ],
        holidayWork: [{ holidayId: 'mem', nurseId: workedMemorialDay }],
        ruleParams: { 'holiday-rotation': { pairMinorWithMajor: true } },
      });
    for (const [worked, expected] of [
      ['ana', 'ben'],
      ['ben', 'ana'],
    ] as const) {
      const report = solve(thanksgiving(worked), { seed: 1, maxIterations: 500 });
      expect(
        report.assignments.map((a) => a.nurseId),
        `${worked} worked Memorial Day`,
      ).toEqual([expected]);
    }
  });
});

describe('paid leave in the hours the objective chases', () => {
  it('does not count a nurse back from a paid vacation as still owed hours', () => {
    // 72 contracted, 36 paid for the vacation week, 36 worked in the other: nothing owed.
    const nurse = makeNurse({ id: 'vac', contractedHoursPerPeriod: 72 });
    const input = solveInputFrom({
      nurses: [nurse],
      shiftTypes: [DAY_12, NIGHT_12],
      timeOff: [timeOff('vac', '2026-01-04', '2026-01-10', { paidHours: 36 })],
    });
    const model = new SolverModel(input);
    for (const date of ['2026-01-11', '2026-01-13', '2026-01-15']) {
      model.add(assign('vac', DAY_12, date));
    }
    expect(model.hoursShort(0)).toBe(0);
  });

  it('still counts unpaid leave as hours the nurse is short', () => {
    const nurse = makeNurse({ id: 'vac', contractedHoursPerPeriod: 72 });
    const input = solveInputFrom({
      nurses: [nurse],
      shiftTypes: [DAY_12, NIGHT_12],
      timeOff: [timeOff('vac', '2026-01-04', '2026-01-10', { type: 'unpaid' })],
    });
    const model = new SolverModel(input);
    for (const date of ['2026-01-11', '2026-01-13', '2026-01-15']) {
      model.add(assign('vac', DAY_12, date));
    }
    expect(model.hoursShort(0)).toBe(36);
  });
});

describe('overtime judged over the pay period', () => {
  // Pay period Sun 4 – Sat 17 Jan 2026. Three 12s and an 8 in the first week is 44h.
  const fortnightly = {
    'max-hours-per-week': { overtimeByPayPeriod: true, payPeriodOvertimeThresholdHours: 80 },
  };
  const input = (ruleParams?: typeof fortnightly) =>
    solveInputFrom({
      nurses: [makeNurse({ id: 'ft', contractedHoursPerPeriod: 120 })],
      shiftTypes: [DAY_12, DAY_8],
      ...(ruleParams ? { ruleParams } : {}),
    });
  const threeTwelves = (model: SolverModel) => {
    for (const date of ['2026-01-04', '2026-01-06', '2026-01-08']) {
      model.add(assign('ft', DAY_12, date));
    }
  };
  const friday8 = (model: SolverModel) =>
    model.shiftAt(model.dateIdx.get(isoDate('2026-01-09'))!, DAY_8);

  it('turns away the 8 that takes the week to 44h when overtime is weekly', () => {
    const model = new SolverModel(input());
    threeTwelves(model);
    expect(model.eligible(0, friday8(model), 'RN')).toBe(false);
  });

  it('offers the 8 that takes the week to 44h when the pay period is still under 80', () => {
    const model = new SolverModel(input(fortnightly));
    threeTwelves(model);
    const shift = friday8(model);
    expect(model.eligible(0, shift, 'RN')).toBe(true);
    expect(model.canAdd(0, model.make(0, shift))).toBe(true);
  });

  it('turns away the shift that takes the pay period past 80', () => {
    const model = new SolverModel(input(fortnightly));
    threeTwelves(model);
    model.add(assign('ft', DAY_8, '2026-01-09'));
    for (const date of ['2026-01-12', '2026-01-14', '2026-01-16']) {
      model.add(assign('ft', DAY_12, date));
    }
    // 80h so far; a Saturday 12 would be 92h in the pay period but only 48h in week two.
    const saturday = model.shiftAt(model.dateIdx.get(isoDate('2026-01-17'))!, DAY_12);
    expect(model.eligible(0, saturday, 'RN')).toBe(false);
  });
});

describe('cover from the day 12', () => {
  it('re-prices the mid 8 when the day 12’s only experienced RN leaves, and back on undo', () => {
    const lead = makeNurse({ id: 'lead', isChargeEligible: true });
    const newGrad = makeNurse({ id: 'new', isNovice: true });
    const model = new SolverModel(
      solveInputFrom({
        nurses: [lead, newGrad],
        shiftTypes: [DAY_12, MID_8],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1, 1),
          ...coverageAllWeek(MID_8, 'RN', 1, 1),
        ],
      }),
    );
    const day = model.dateIdx.get(isoDate('2026-01-05'))!;
    const mid = model.shiftAt(day, MID_8);
    model.add(assign('new', MID_8, '2026-01-05'));
    const alone = model.coveragePenaltyOf(mid);
    const onDay = assign('lead', DAY_12, '2026-01-05');
    model.add(onDay);
    const covered = model.coveragePenaltyOf(mid);
    expect(covered).toBeLessThan(alone);
    const token = model.remove(onDay);
    expect(model.coveragePenaltyOf(mid)).toBe(alone);
    model.undoRemove(onDay, token);
    expect(model.coveragePenaltyOf(mid)).toBe(covered);
  });
});

describe('a short licensed pool', () => {
  it('names the LVN, then the RN, as what would fill it, so the search aims there', () => {
    const rns = [makeNurse({ id: 'rn1', isChargeEligible: true }), makeNurse({ id: 'rn2' })];
    const lvn = makeNurse({ id: 'lvn', role: 'LPN' });
    const model = new SolverModel(
      solveInputFrom({
        nurses: [...rns, lvn],
        shiftTypes: [DAY_12],
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
        // 20 patients: four licensed nurses, at least two of them RNs.
        censusForecasts: [census('2026-01-05', DAY_12, { [TIER_ROUTINE.id]: 20 })],
      }),
    );
    const day = model.shiftAt(model.dateIdx.get(isoDate('2026-01-05'))!, DAY_12);
    model.add(assign('rn1', DAY_12, '2026-01-05'));
    // One RN on: one more RN for the share and two of either for the pool, three nurses (not
    // four: the share's RN counts toward the pool).
    expect(model.hardShortfall()).toBe(3);
    model.add(assign('rn2', DAY_12, '2026-01-05'));
    expect(model.hardShortfall()).toBe(2);
    // The RN share is met; the pool is two short.
    expect(model.shortRoles(day)).toEqual(['LPN', 'RN']);
    expect(model.shortShifts()).toContain(day);
    model.add(assign('lvn', DAY_12, '2026-01-05'));
    expect(model.shortRoles(day)).toEqual(['LPN', 'RN']);
    expect(model.hardShortfall()).toBe(1);
  });
});

describe('charge nurses', () => {
  it('makes the first eligible nurse on the day 12 charge, but not on the mid 8 it overlaps', () => {
    const nurse = makeNurse({ id: 'lead', isChargeEligible: true });
    const other = makeNurse({ id: 'lead2', isChargeEligible: true });
    const model = new SolverModel(
      solveInputFrom({
        nurses: [nurse, other],
        shiftTypes: [DAY_12, MID_8],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(MID_8, 'RN', 1),
        ],
      }),
    );
    model.add(assign('lead', DAY_12, '2026-01-05'));
    model.add(assign('lead2', MID_8, '2026-01-05'));
    const day = model.dateIdx.get(isoDate('2026-01-05'))!;
    expect(model.roster(model.shiftAt(day, DAY_12)).map((a) => a.isCharge)).toEqual([true]);
    expect(model.roster(model.shiftAt(day, MID_8)).map((a) => a.isCharge)).toEqual([false]);
  });
});

/**
 * A soft rule the solver prices is judged twice: by the rule engine, which the grid shows, and
 * by `SolverModel`'s own incremental counter, which Generate optimises. Hand-worked cases above
 * pin each price; this checks the two counts agree on random schedules, and that every soft rule
 * has been accounted for — so a new soft rule cannot ship priced by convention alone.
 */
describe('soft rules priced the way the grid judges them', () => {
  /** How the solver counts each natively soft rule, or why it needs no counter of its own. */
  const PRICED: Record<string, ((m: SolverModel) => number) | string> = {
    'recovery-after-nights': (m) => m.recoveryBreaches(),
    'avoid-pending-time-off': (m) => m.pendingBreaches(),
    'holiday-rotation': (m) => m.holidayBreaches(),
    'weekend-pattern': (m) => m.weekendBreaches(),
    'incompatible-staff-cap':
      'priced per person-hour over floor stretches; checked against the rule in the walk above',
  };

  it('accounts for every soft rule in the registry', () => {
    const soft = ALL_RULES.filter((r) => r.severity === 'soft').map((r) => r.id);
    expect(soft.filter((id) => !(id in PRICED))).toEqual([]);
  });

  function engineCount(input: SolveInput, model: SolverModel, ruleId: string): number {
    const view = new ScheduleView({
      period: input.period,
      assignments: model.assignments(),
      priorAssignments: input.priorAssignments,
      nurses: model.nurses,
      shiftTypes: model.shiftTypes,
    });
    return evaluateSchedule(view, input.ruleSet, model.ctx).violations.filter(
      (v) => v.ruleId === ruleId && v.severity === 'soft',
    ).length;
  }

  it('counts the same breaches as the rule engine on random schedules', () => {
    // Agreement on all-zero schedules would prove nothing: every rule must fire somewhere.
    const seen = new Map<string, number>();
    for (const options of [
      {},
      { pending: true },
      { holidays: true },
      { pending: true, holidays: true },
      { weekends: true },
    ]) {
      for (let seed = 1; seed <= 12; seed++) {
        resetFixtureCounters();
        const input = scenario(options);
        const model = new SolverModel(input);
        const rng = new Rng(seed);
        for (let step = 0; step < 60; step++) {
          const n = rng.nextInt(0, model.nurses.length - 1);
          const shift = model.shifts[rng.nextInt(0, model.shifts.length - 1)]!;
          const mine = model.timeline(n).filter((a) => !a.isLocked);
          if (mine.length > 0 && rng.chance(0.3)) {
            model.remove(rng.pick(mine));
            continue;
          }
          const candidate = model.make(n, shift);
          if (model.canAdd(n, candidate)) model.add(candidate);
        }
        for (const [ruleId, count] of Object.entries(PRICED)) {
          if (typeof count === 'string') continue;
          const judged = engineCount(input, model, ruleId);
          expect(count(model), `${ruleId} ${JSON.stringify(options)} seed ${seed}`).toBe(judged);
          seen.set(ruleId, (seen.get(ruleId) ?? 0) + judged);
        }
      }
    }
    for (const [ruleId, count] of Object.entries(PRICED)) {
      if (typeof count !== 'string') expect(seen.get(ruleId), ruleId).toBeGreaterThan(0);
    }
  });
});
