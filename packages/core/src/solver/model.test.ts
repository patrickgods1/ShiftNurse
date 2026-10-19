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
import type {
  Assignment,
  FairnessLedgerEntry,
  Nurse,
  NurseRole,
  Preference,
} from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { computeBurden } from '../fairness/burden.js';
import { deriveCounters } from '../fairness/ledger.js';
import { BURDEN_COMPONENTS, BURDEN_COUNTER } from '../fairness/types.js';
import { ALL_RULES, defaultRuleSet, evaluateSchedule } from '../rules/registry.js';
import { busyElsewhere } from '../schedule/elsewhere.js';
import { ScheduleView } from '../schedule/view.js';
import {
  assign,
  assignRun,
  CRED_ACLS,
  census,
  coverage,
  coverageAllWeek,
  credentialRequirement,
  DAY_8,
  DAY_12,
  EVENING_8,
  MID_8,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  ON_CALL,
  payRate,
  resetFixtureCounters,
  solveInputFrom,
  TIER_ROUTINE,
  timeOff,
  UNIT_ID,
  withRuleParams,
} from '../testing/fixtures.js';
import { anneal } from './anneal.js';
import { greedySeed } from './greedy.js';
import { SolverModel } from './model.js';
import { Rng } from './rng.js';
import { solve } from './solver.js';
import { DEFAULT_OBJECTIVE_WEIGHTS, type SolveInput } from './types.js';

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

  it('counts a third weekend in four, with last schedule’s weekend in the window', () => {
    const base = scenario({ weekends: true });
    const input: SolveInput = {
      ...base,
      ruleSet: {
        ...base.ruleSet,
        configs: base.ruleSet.configs.map((c) =>
          c.ruleId === 'weekend-pattern'
            ? { ...c, params: { maxConsecutiveWeekends: 3, maxWeekendsPer4Weeks: 2 } }
            : c,
        ),
      },
    };
    // Nurse 1 worked Sat 27 Dec last period and works Sat 10 and Sat 17 Jan: the four weeks to
    // 17 Jan (27 Dec, 3, 10, 17 Jan) hold three weekends worked, one past the two allowed.
    const model = new SolverModel(input);
    const n = model.nurseIdx.get(input.nurses[1]!.id)!;
    for (const day of [6, 13]) model.add(model.make(n, model.shiftAt(day, DAY_12)));
    expect(model.weekendBreaches()).toBe(1);
    const view = new ScheduleView({
      period: input.period,
      assignments: model.assignments(),
      priorAssignments: input.priorAssignments,
      nurses: model.nurses,
      shiftTypes: model.shiftTypes,
    });
    const judged = evaluateSchedule(view, input.ruleSet, model.ctx).violations.filter(
      (v) => v.ruleId === 'weekend-pattern',
    );
    expect(judged.map((v) => v.details)).toEqual([
      { weekend: '2026-01-17', workedIn4Weeks: 3, excess: 1 },
    ]);
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

  it('prices an evening tour after a night as the quick flip the grid flags', () => {
    // A Title 38 evening tour (15:30, paid as a night) is a day-side shift: night Mon 5, evening
    // Wed 7 leaves 7 − 5 − 1 = 1 day off, short of 2, so one breach.
    const eveningTour = { ...EVENING_8, id: 'st-e8-va', startTime: '15:30', isNight: true };
    const nurse = makeNurse({ id: 'nurse-e' });
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [nurse],
      shiftTypes: [DAY_12, NIGHT_12, eveningTour],
      coverageRequirements: [
        coverage(NIGHT_12, 'RN', 1, 1, null, isoDate('2026-01-05')),
        coverage(eveningTour, 'RN', 1, 1, null, isoDate('2026-01-07')),
      ],
    });
    const model = new SolverModel(input);
    const n = model.nurseIdx.get('nurse-e')!;
    // Date indexes from Sun 4 Jan: Mon 5 is 1, Wed 7 is 3.
    model.add(model.make(n, model.shiftAt(1, NIGHT_12)));
    model.add(model.make(n, model.shiftAt(3, eveningTour)));
    expect(model.recoveryBreaches()).toBe(1);
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

describe('annealer cache drift', () => {
  it("the annealer's caches still match a fresh model after a long run", () => {
    const input = scenario({
      mid: true,
      groups: true,
      holidays: true,
      pending: true,
      weekends: true,
    });
    const model = new SolverModel(input);
    greedySeed(model);
    anneal(model, new Rng(11), { seed: 11, maxIterations: 2000 }, { shouldStop: () => null });
    const fresh = rebuild(input, model);
    const got = model.breakdown();
    const want = fresh.breakdown();
    for (const term of Object.keys(got) as (keyof typeof got)[]) {
      expect(got[term], term).toBeCloseTo(want[term], 6);
    }
  });
});

/**
 * What the Fairness page would say the model's fairness term is, computed with that page's own
 * machinery: the same view, `deriveCounters` and `computeBurden` that `report.ts` hands to
 * `scoreFairness`, over-share read straight from the page's `fairShare`. What this checks is the
 * counters, the age decay, the exposure and the fair weights the model keeps incrementally.
 */
function fairnessAsThePageComputesIt(model: SolverModel): number {
  const { input } = model;
  const view = new ScheduleView({
    period: input.period,
    assignments: model.assignments(),
    priorAssignments: input.priorAssignments,
    nurses: model.nurses,
    shiftTypes: model.shiftTypes,
  });
  const counters = deriveCounters(view, {
    unit: input.unit,
    holidayDates: model.ctx.holidayDates,
    holidayDateById: new Map(input.holidays.map((h) => [h.id, h.date])),
    weekendDefinition: input.ruleSet.weekendDefinition,
    preferences: input.preferences,
    timeOff: input.timeOff,
  });
  const active = model.candidates.map((i) => model.nurses[i]!);
  const weights = input.ruleSet.fairnessWeights;
  const scope = {
    asOf: input.period.startDate,
    periodDays: view.dates.length,
    payPeriodDays: input.unit.payPeriodDays,
  };
  const burden = computeBurden(active, input.ledgerHistory, scope, { weights }, counters);
  let total = 0;
  for (const c of BURDEN_COMPONENTS) {
    if (weights[c] <= 0) continue;
    const key = BURDEN_COUNTER[c];
    for (const nb of burden.byNurse.values()) {
      if (!nb.comparable) continue;
      total += weights[c] * Math.max(0, nb.carried[key] - nb.fairShare[c]);
    }
  }
  return total * DEFAULT_OBJECTIVE_WEIGHTS.fairness;
}

function ledgerRow(
  nurseId: string,
  periodId: string,
  periodStart: string,
  counts: Partial<FairnessLedgerEntry>,
): FairnessLedgerEntry {
  return {
    id: `ledger-${nurseId}-${periodId}`,
    nurseId,
    periodId,
    periodStart: isoDate(periodStart),
    nightShifts: 0,
    weekendsWorked: 0,
    holidaysWorked: 0,
    onCallShifts: 0,
    undesirableShifts: 0,
    requestsApproved: 0,
    requestsDenied: 0,
    callOutsCovered: 0,
    totalHours: 0,
    overtimeHours: 0,
    preferenceHitRate: 1,
    periodDays: 14,
    availableDays: 14,
    ...counts,
  };
}

/** Rule set with the two rules that add their own fairness price switched off. */
function burdenOnly(weights?: Partial<Record<string, number>>) {
  const base = defaultRuleSet('unit-1');
  return {
    ...base,
    configs: base.configs.map((c) =>
      c.ruleId === 'holiday-rotation' || c.ruleId === 'weekend-pattern'
        ? { ...c, enabled: false }
        : c,
    ),
    ...(weights
      ? { fairnessWeights: { ...base.fairnessWeights, ...weights } as typeof base.fairnessWeights }
      : {}),
  };
}

describe('fairness priced as the Fairness page prices it', () => {
  it('prices fairness exactly as the Fairness page would compute it, move after move', () => {
    const hours = [72, 72, 72, 48, 48, 72];
    const nurses = hours.map((h, i) =>
      makeNurse({ isChargeEligible: i % 2 === 0, contractedHoursPerPeriod: h }),
    );
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses,
      shiftTypes: [DAY_12, NIGHT_12, ON_CALL],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 2, 3),
        ...coverageAllWeek(NIGHT_12, 'RN', 1, 2),
        ...coverageAllWeek(ON_CALL, 'RN', 0, 1),
      ],
      holidays: [
        {
          id: 'h1',
          unitId: 'unit-1',
          date: isoDate('2026-01-08'),
          name: 'Test day',
          isMajor: false,
          pairedHolidayId: null,
        },
      ],
      preferences: [
        {
          id: 'p1',
          nurseId: nurses[0]!.id,
          kind: 'avoid_shift_type',
          shiftTypeId: NIGHT_12.id,
          weight: 4,
        },
      ],
      // Four nurses with history that differs on every counter, dated at different ages (two weeks
      // to half a year back) and part-available; nurse 3's leave period has no available days, so it
      // must weigh nothing. Nurses 4 and 5 have none.
      ledgerHistory: [
        ledgerRow(nurses[0]!.id, 'prev', '2025-12-21', {
          nightShifts: 6,
          weekendsWorked: 2,
          holidaysWorked: 1,
          onCallShifts: 3,
          undesirableShifts: 4,
          overtimeHours: 8,
          totalHours: 84,
        }),
        ledgerRow(nurses[1]!.id, 'prev', '2025-12-21', {
          nightShifts: 1,
          weekendsWorked: 4,
          holidaysWorked: 0,
          onCallShifts: 0,
          undesirableShifts: 1,
          overtimeHours: 0,
          totalHours: 72,
        }),
        ledgerRow(nurses[1]!.id, 'prev2', '2025-07-06', {
          nightShifts: 3,
          holidaysWorked: 2,
          totalHours: 72,
        }),
        ledgerRow(nurses[2]!.id, 'prev', '2025-10-12', {
          availableDays: 9,
          nightShifts: 0,
          weekendsWorked: 1,
          holidaysWorked: 1,
          onCallShifts: 5,
          overtimeHours: 12,
          totalHours: 90,
        }),
        ledgerRow(nurses[3]!.id, 'prev', '2025-12-21', {
          nightShifts: 2,
          weekendsWorked: 0,
          undesirableShifts: 2,
          totalHours: 48,
        }),
        ledgerRow(nurses[3]!.id, 'leave', '2025-11-23', {
          availableDays: 0,
          nightShifts: 5,
          weekendsWorked: 3,
          totalHours: 0,
        }),
      ],
      ruleSet: burdenOnly(),
    });

    const model = new SolverModel(input);
    const rng = new Rng(5);
    let checked = 0;
    let peak = 0;
    for (let step = 1; step <= 300; step++) {
      if (model.unlocked.length === 0 || rng.chance(0.6)) {
        const shift = rng.pick(model.solvableShifts);
        const n = rng.pick(model.candidates);
        if (model.eligible(n, shift, null)) {
          const a = model.make(n, shift);
          if (model.canAdd(n, a)) model.add(a);
        }
      } else {
        model.remove(rng.pick(model.unlocked));
      }
      if (step % 25 !== 0) continue;
      const got = model.breakdown().fairness;
      peak = Math.max(peak, got);
      expect(got, `fairness after step ${step}`).toBeCloseTo(fairnessAsThePageComputesIt(model), 6);
      checked++;
    }
    expect(checked).toBe(12);
    expect(model.unlocked.length).toBeGreaterThan(10);
    // A walk that never moved the term would agree with anything.
    expect(peak).toBeGreaterThan(0);
  });

  // A per-diem nurse has no contract to be over, so the ledger (and so the Fairness page) counts
  // none of her hours as burden; the model must price the same nothing.
  it('charges a per-diem nurse no hours-over-contract burden, as the ledger does', () => {
    const ft = makeNurse({ isChargeEligible: true, contractedHoursPerPeriod: 72 });
    const pd = makeNurse({ employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [ft, pd],
      shiftTypes: [DAY_12],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      ledgerHistory: [
        ledgerRow(ft.id, 'prev', '2025-12-21', { totalHours: 72 }),
        ledgerRow(pd.id, 'prev', '2025-12-21', { totalHours: 36 }),
      ],
      ruleSet: burdenOnly({
        nights: 0,
        weekends: 0,
        holidays: 0,
        onCall: 0,
        undesirable: 0,
        overtime: 1,
        preferences: 0,
        timeOff: 0,
      }),
    });
    const model = new SolverModel(input);
    const pdIdx = model.nurses.findIndex((n) => n.id === pd.id);
    for (const date of ['2026-01-05', '2026-01-07', '2026-01-09']) {
      const shift = model.shifts.find((s) => s.date === date && s.shiftType.id === DAY_12.id)!;
      model.add(model.make(pdIdx, shift));
    }
    expect(fairnessAsThePageComputesIt(model)).toBe(0);
    expect(model.breakdown().fairness).toBeCloseTo(fairnessAsThePageComputesIt(model), 6);
  });

  it('counts an evening tour that carries night pay as a day-side shift in the night burden', () => {
    // A Title 38 evening tour starts at 15:00 and is paid the night differential. Ana works it
    // three times; nobody works a night tour, so the night team total is 0 and nobody is over
    // share. Counted by the pay flag, Ana would carry 3 against a share of 1.5.
    const eveningNightPay = { ...EVENING_8, id: 'st-e8-np', isNight: true };
    const ana = makeNurse({ isChargeEligible: true, contractedHoursPerPeriod: 72 });
    const bo = makeNurse({ isChargeEligible: true, contractedHoursPerPeriod: 72 });
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [ana, bo],
      shiftTypes: [DAY_12, eveningNightPay],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1, 1),
        ...coverageAllWeek(eveningNightPay, 'RN', 0, 1),
      ],
      ruleSet: burdenOnly({
        nights: 1,
        weekends: 0,
        holidays: 0,
        onCall: 0,
        undesirable: 0,
        overtime: 0,
        preferences: 0,
        timeOff: 0,
      }),
    });
    const model = new SolverModel(input);
    const anaIdx = model.nurses.findIndex((n) => n.id === ana.id);
    for (const date of ['2026-01-05', '2026-01-07', '2026-01-09']) {
      const shift = model.shifts.find(
        (s) => s.date === date && s.shiftType.id === eveningNightPay.id,
      )!;
      model.add(model.make(anaIdx, shift));
    }
    expect(model.breakdown().fairness).toBe(0);
  });
});

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

describe('a nurse who wants to work the holiday', () => {
  // MLK Day needs one RN and Bo already works it. Ana, the most senior (1.5×), wants it at full
  // strength (5): a reward of 5 / 2 × 1.5 × 10 = 37.5. Because she wants that date, one RN over
  // target there costs overTarget 8 plus the date's largest reward, 37.5: 45.5.
  const staffedHoliday = (withPay: boolean): SolveInput => {
    const ana = makeNurse({
      id: 'ana',
      employmentType: 'per_diem',
      contractedHoursPerPeriod: 0,
      seniorityDate: isoDate('2010-01-01'),
    });
    const bo = makeNurse({
      id: 'bo',
      employmentType: 'per_diem',
      contractedHoursPerPeriod: 0,
      isChargeEligible: true,
      seniorityDate: isoDate('2020-01-01'),
    });
    return solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [ana, bo],
      shiftTypes: [DAY_12],
      coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-12'))],
      holidays: [
        {
          id: 'mlk',
          unitId: UNIT_ID,
          date: isoDate('2026-01-12'),
          name: 'MLK Day',
          isMajor: true,
          pairedHolidayId: null,
        },
      ],
      preferences: [
        { id: 'p-ana', nurseId: 'ana', kind: 'holiday_appetite', holidayId: 'mlk', weight: 5 },
      ],
      ...(withPay
        ? { cost: { payRates: [payRate(52)], differentials: [], overtimeRules: [] } }
        : {}),
    });
  };
  /** What adding Ana to MLK Day costs once Bo already covers it. */
  const addingAna = (input: SolveInput): number => {
    const model = new SolverModel(input);
    const mlk = model.shiftAt(8, DAY_12);
    expect(mlk.date).toBe('2026-01-12');
    model.add(model.make(model.nurseIdx.get('bo')!, mlk));
    const before = model.objective();
    model.add(model.make(model.nurseIdx.get('ana')!, mlk));
    return model.objective() - before;
  };

  it('is not added on top of a holiday shift already at its target, however keen and senior', () => {
    // 45.5 over target + 12h × $52 × 0.05 = 31.2 in pay − her reward 37.5 = 39.2.
    expect(addingAna(staffedHoliday(true))).toBeCloseTo(39.2, 6);
  });

  it('an inactive volunteer does not raise the holiday surplus price', () => {
    // Ana has left the unit, so no Generate can give her MLK Day: her wish pays no reward, and one
    // RN over target there costs the plain overTarget, 8.
    const input = staffedHoliday(false);
    const left = {
      ...input,
      nurses: input.nurses.map((n) => (n.id === 'ana' ? { ...n, active: false } : n)),
    };
    const model = new SolverModel(left);
    expect(model.overTargetPrice(model.shiftAt(8, DAY_12), 'RN')).toBe(8);
  });

  it('leaves a keen volunteer off a staffed holiday even with no pay rates', () => {
    // 45.5 over target − her reward 37.5 = 8: the surplus still costs what any surplus does.
    expect(addingAna(staffedHoliday(false))).toBeCloseTo(8, 6);
  });
});

describe('stated preferences', () => {
  // One nurse, so her seniority multiplier is 1. Sun 4 Jan 2026 starts the period: Mon 5 is day
  // 1, Tue 6 day 2, Wed 7 day 3.
  const withPrefs = (preferences: Preference[]) =>
    new SolverModel(
      solveInputFrom({
        startDate: isoDate('2026-01-04'),
        endDate: isoDate('2026-01-17'),
        nurses: [makeNurse({ id: 'ada' })],
        shiftTypes: [DAY_12, NIGHT_12],
        preferences,
      }),
    );
  const mondaysAndTuesdays: Preference[] = [
    { id: 'p-mon', nurseId: 'ada', kind: 'prefer_weekday', weekday: 1, weight: 4 },
    { id: 'p-tue', nurseId: 'ada', kind: 'prefer_weekday', weekday: 2, weight: 2 },
  ];

  it('does not charge a nurse on either of the two days she prefers', () => {
    const model = withPrefs(mondaysAndTuesdays);
    expect(model.preferencePenalty(0, model.shiftAt(1, DAY_12))).toBe(0);
    expect(model.preferencePenalty(0, model.shiftAt(2, DAY_12))).toBe(0);
    // Neither day: the stronger wish, 4, at half.
    expect(model.preferencePenalty(0, model.shiftAt(3, DAY_12))).toBe(2);
  });

  it('charges each kind of wish once', () => {
    const model = withPrefs([
      ...mondaysAndTuesdays,
      { id: 'p-n', nurseId: 'ada', kind: 'prefer_shift_type', shiftTypeId: NIGHT_12.id, weight: 3 },
    ]);
    // A Monday day: the night wish missed (3 / 2), the weekday wish met.
    expect(model.preferencePenalty(0, model.shiftAt(1, DAY_12))).toBe(1.5);
    // A Wednesday day: both kinds missed, 1.5 + 2.
    expect(model.preferencePenalty(0, model.shiftAt(3, DAY_12))).toBe(3.5);
    // A Wednesday night: the shift type met, the weekday missed.
    expect(model.preferencePenalty(0, model.shiftAt(3, NIGHT_12))).toBe(2);
  });

  it('still charges the full weight for a shift she asked to avoid', () => {
    const model = withPrefs([
      ...mondaysAndTuesdays,
      { id: 'p-wed', nurseId: 'ada', kind: 'avoid_weekday', weekday: 3, weight: 2 },
    ]);
    // Avoided Wednesday 2 + the missed weekday wish 2.
    expect(model.preferencePenalty(0, model.shiftAt(3, DAY_12))).toBe(4);
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

describe('authorised overtime and the contract ceiling', () => {
  // Locked D12s on Jan 5, 7, 9, 11, 13 and 17: 72h of a 72h contract. Flagged, Jan 11 is
  // authorised overtime, leaving 60h straight time; a 12 on Jan 15 makes 72 ≤ 76. Unflagged it
  // makes 84 > 76. The week of Jan 11 is then 48h, within the cap; the overtime threshold is
  // switched off so only the contract decides.
  const input = (flagged: boolean) =>
    solveInputFrom({
      nurses: [makeNurse({ id: 'ada', contractedHoursPerPeriod: 72, isChargeEligible: true })],
      shiftTypes: [DAY_12, NIGHT_12],
      assignments: [
        ...['2026-01-05', '2026-01-07', '2026-01-09', '2026-01-13', '2026-01-17'].map((d) =>
          assign('ada', DAY_12, d, { isLocked: true }),
        ),
        assign('ada', DAY_12, '2026-01-11', { isLocked: true, isOvertime: flagged }),
      ],
      ruleParams: { 'max-hours-per-week': { requireOvertimeAuthorisation: false } },
    });
  const jan15 = (model: SolverModel) =>
    model.shiftAt(model.dateIdx.get(isoDate('2026-01-15'))!, DAY_12);

  it('does not count a locked overtime shift against the contract ceiling', () => {
    const model = new SolverModel(input(true));
    expect(model.eligible(0, jan15(model), 'RN')).toBe(true);
  });

  it('still counts the same locked shift when it is not marked as overtime', () => {
    const model = new SolverModel(input(false));
    expect(model.eligible(0, jan15(model), 'RN')).toBe(false);
  });
});

describe('contracted hours across the start of a schedule', () => {
  // Schedule Sun 11 – Sat 24 Jan 2026; the fixture unit's pay periods run Sun 4 – Sat 17 and
  // Sun 18 – Sat 31. Last schedule worked D12 Sun 4 – Thu 8 Jan: 5 × 12 = 60h of a 72h contract.
  const input = (historyFrom?: string) =>
    solveInputFrom({
      startDate: isoDate('2026-01-11'),
      endDate: isoDate('2026-01-24'),
      ...(historyFrom ? { historyFrom: isoDate(historyFrom) } : {}),
      nurses: [makeNurse({ id: 'ana', contractedHoursPerPeriod: 72 })],
      shiftTypes: [DAY_12, NIGHT_12],
      priorAssignments: assignRun('ana', DAY_12, '2026-01-04', 5, { periodId: 'prev' }),
    });

  it('counts the shifts already published toward the pay period the schedule finishes', () => {
    const model = new SolverModel(input('2025-12-14'));
    const b = model.bucketOfDate[model.dateIdx.get(isoDate('2026-01-11'))!]!;
    // Still owed 72 − 60 = 12h; room for 72 + 4 tolerance − 60 = 16h before the contract is passed.
    expect(model.hoursTarget[0]![b]).toBe(12);
    expect(model.hoursCap[0]![b]).toBe(16);
    const monday = model.shiftAt(model.dateIdx.get(isoDate('2026-01-12'))!, DAY_12);
    expect(model.eligible(0, monday, 'RN')).toBe(true);
    expect(model.canAdd(0, model.make(0, monday))).toBe(true);
    model.add(assign('ana', DAY_12, '2026-01-12'));
    // A second 12 makes 60 + 24 = 84h in the pay period, past the 76h the contract allows.
    const tuesday = model.shiftAt(model.dateIdx.get(isoDate('2026-01-13'))!, DAY_12);
    expect(model.eligible(0, tuesday, 'RN')).toBe(false);
    expect(model.canAdd(0, model.make(0, tuesday))).toBe(false);
  });

  it('leaves a published overtime shift out of the room the contract allows', () => {
    // Last schedule worked D12 Sun 4 – Wed 7 Jan: 48h, the Wednesday marked authorised overtime.
    // Flagged, 36h of it is straight time: room 72 + 4 − 48 + 12 = 40h. Unflagged: 72 + 4 − 48 =
    // 28h. With 12s on Mon 12 and Wed 14 (24h), a third on Fri 16 makes 36h: within 40, past 28.
    // The week of Jan 11 is then 36h, under the 40h overtime threshold.
    const withPrior = (flagged: boolean) => {
      const model = new SolverModel(
        solveInputFrom({
          startDate: isoDate('2026-01-11'),
          endDate: isoDate('2026-01-24'),
          historyFrom: isoDate('2025-12-14'),
          nurses: [makeNurse({ id: 'ana', contractedHoursPerPeriod: 72 })],
          shiftTypes: [DAY_12, NIGHT_12],
          priorAssignments: [
            ...assignRun('ana', DAY_12, '2026-01-04', 3, { periodId: 'prev' }),
            assign('ana', DAY_12, '2026-01-07', { periodId: 'prev', isOvertime: flagged }),
          ],
        }),
      );
      model.add(assign('ana', DAY_12, '2026-01-12'));
      model.add(assign('ana', DAY_12, '2026-01-14'));
      const b = model.bucketOfDate[model.dateIdx.get(isoDate('2026-01-11'))!]!;
      const friday = model.shiftAt(model.dateIdx.get(isoDate('2026-01-16'))!, DAY_12);
      return { model, b, friday };
    };
    const flagged = withPrior(true);
    expect(flagged.model.hoursCap[0]![flagged.b]).toBe(40);
    expect(flagged.model.eligible(0, flagged.friday, 'RN')).toBe(true);
    expect(flagged.model.canAdd(0, flagged.model.make(0, flagged.friday))).toBe(true);
    const plain = withPrior(false);
    expect(plain.model.hoursCap[0]![plain.b]).toBe(28);
    expect(plain.model.eligible(0, plain.friday, 'RN')).toBe(false);
    expect(plain.model.canAdd(0, plain.model.make(0, plain.friday))).toBe(false);
  });

  it('keeps every bucket as before when no history is given', () => {
    // Jan 11–24 holds no whole pay period (Jan 4–17 starts before it, Jan 18–31 ends after it),
    // so all 14 days are one remainder bucket owed 72 × 14 / 14 = 72h, the published 60h unread.
    const model = new SolverModel(input());
    expect(model.bucketOfDate.every((b) => b === 0)).toBe(true);
    expect(model.hoursTarget[0]).toEqual([72]);
  });

  it('owes the whole contract in each pay period the schedule touches when told to judge partial ones', () => {
    // Without history the rule judges Jan 4–17 and Jan 18–31 each on this schedule's own shifts,
    // against all 72h (not 7/14 of it), and the published 60h is not read: target 72, cap 76 each.
    const model = new SolverModel({
      ...input(),
      ruleSet: withRuleParams(defaultRuleSet(UNIT_ID), {
        'fte-target-hours': { onlyCompletePayPeriods: false },
      }),
    });
    expect(model.bucketOfDate[model.dateIdx.get(isoDate('2026-01-17'))!]).toBe(0);
    expect(model.bucketOfDate[model.dateIdx.get(isoDate('2026-01-18'))!]).toBe(1);
    expect(model.hoursTarget[0]).toEqual([72, 72]);
    expect(model.hoursCap[0]).toEqual([76, 76]);
  });
});

describe('which published hours count toward the pay period a schedule finishes', () => {
  // Schedule Sun 11 – Sat 24 Jan, history whole from 14 Dec; pay period Sun 4 – Sat 17 judged.
  // Published: D12 Sun 4, D12 Mon 5 held over 6h, a day on 5 West Wed 7, D12 Thu 8, standby
  // Fri 9. The contract counts 3 × 12 = 36h of it: the holdover was not scheduled, 5 West's day
  // is that unit's contract, and standby is not hours worked unless the rule says so.
  const WEST_DAY = { ...DAY_12, id: 'west-d12', unitId: 'unit-west' };
  const west = busyElsewhere(
    [assign('ana', WEST_DAY, '2026-01-07', { periodId: 'west' })],
    [WEST_DAY],
    '5 West',
  );
  const input = (ruleParams?: Record<string, Record<string, unknown>>) =>
    solveInputFrom({
      startDate: isoDate('2026-01-11'),
      endDate: isoDate('2026-01-24'),
      historyFrom: isoDate('2025-12-14'),
      nurses: [makeNurse({ id: 'ana', contractedHoursPerPeriod: 72 })],
      shiftTypes: [DAY_12, NIGHT_12, ON_CALL, ...west.shiftTypes],
      priorAssignments: [
        assign('ana', DAY_12, '2026-01-04', { periodId: 'prev' }),
        assign('ana', DAY_12, '2026-01-05', { periodId: 'prev', holdoverMinutes: 360 }),
        ...west.assignments,
        assign('ana', DAY_12, '2026-01-08', { periodId: 'prev' }),
        assign('ana', ON_CALL, '2026-01-09', { periodId: 'prev' }),
      ],
      ...(ruleParams ? { ruleParams } : {}),
    });
  const firstBucket = (model: SolverModel) =>
    model.bucketOfDate[model.dateIdx.get(isoDate('2026-01-11'))!]!;

  it('counts a held-over shift by its scheduled hours and leaves out other units and standby', () => {
    // 72 − 36 = 36h still owed; 72 + 4 − 36 = 40h of room.
    const model = new SolverModel(input());
    expect(model.hoursTarget[0]![firstBucket(model)]).toBe(36);
    expect(model.hoursCap[0]![firstBucket(model)]).toBe(40);
  });

  it('counts the standby too when the contract credits time on call', () => {
    // 36 + 12h standby = 48h published: 24h owed, 28h of room.
    const model = new SolverModel(input({ 'fte-target-hours': { onCallCountsTowardHours: true } }));
    expect(model.hoursTarget[0]![firstBucket(model)]).toBe(24);
    expect(model.hoursCap[0]![firstBucket(model)]).toBe(28);
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

  it('hands the charge role to the first RN, passing over a charge-eligible LPN', () => {
    const lpn = makeNurse({ id: 'lena', role: 'LPN', isChargeEligible: true });
    const rn = makeNurse({ id: 'ana', isChargeEligible: true });
    const model = new SolverModel(
      solveInputFrom({
        nurses: [lpn, rn],
        shiftTypes: [DAY_12],
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
      }),
    );
    // The LPN is on the roster first; under the default only an RN may run the shift.
    model.add(assign('lena', DAY_12, '2026-01-05'));
    model.add(assign('ana', DAY_12, '2026-01-05'));
    const day = model.dateIdx.get(isoDate('2026-01-05'))!;
    const charge = model
      .roster(model.shiftAt(day, DAY_12))
      .map((a) => [a.nurseId, a.isCharge] as const);
    expect(charge).toEqual([
      ['lena', false],
      ['ana', true],
    ]);
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
    'tour-rotation':
      'not priced while soft (Generate does not avoid it); the hard encoders forbid it outright',
    'days-off-together':
      'not priced while soft (Generate does not avoid it); the hard encoders forbid it outright',
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

describe('tour rotation made hard', () => {
  function input(): SolveInput {
    const rules = defaultRuleSet(UNIT_ID);
    return solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [makeNurse({ id: 'ada', firstName: 'Ada' })],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(NIGHT_12, 'RN', 1),
      ],
      ruleSet: {
        ...rules,
        configs: rules.configs.map((c) =>
          c.ruleId === 'tour-rotation'
            ? { ...c, enabled: true, severityOverride: 'hard' as const }
            : c,
        ),
      },
    });
  }
  const dayOn = (model: SolverModel, date: string) =>
    model.make(0, model.shiftAt(model.dateIdx.get(isoDate(date))!, DAY_12));

  it('turns away a day shift 24 hours after a night, and offers it after 48', () => {
    const model = new SolverModel(input());
    model.add(assign('ada', NIGHT_12, '2026-01-05'));
    expect(model.canAdd(0, dayOn(model, '2026-01-07'))).toBe(false);
    expect(model.canAdd(0, dayOn(model, '2026-01-08'))).toBe(true);
  });

  it('stays legal when a shift is taken away', () => {
    const model = new SolverModel(input());
    const night = assign('ada', NIGHT_12, '2026-01-05');
    model.add(night);
    model.add(dayOn(model, '2026-01-08'));
    model.remove(night);
    expect(model.isLegal(0)).toBe(true);
  });
});

describe('long stretches made hard', () => {
  function input(restHours: number): SolveInput {
    const rules = defaultRuleSet(UNIT_ID);
    return solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [makeNurse({ id: 'ada', firstName: 'Ada' })],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(NIGHT_12, 'RN', 1),
      ],
      ruleSet: {
        ...rules,
        configs: rules.configs.map((c) => {
          if (c.ruleId === 'min-rest-between-shifts') {
            return { ...c, params: { ...c.params, minRestHours: 0 } };
          }
          return c.ruleId === 'long-stretch'
            ? {
                ...c,
                enabled: true,
                severityOverride: 'hard' as const,
                params: { ...c.params, restAfterHours: 12, restHours },
              }
            : c;
        }),
      },
    });
  }

  // Day 12 Mon 07-19, night 12 Mon 19-07, day 12 Tue 07-19: one 36-hour stretch. Without the
  // night, the Monday day is a 12-hour stretch followed by Tuesday's day 12 hours later.
  const roster = () => [
    assign('ada', DAY_12, '2026-01-05'),
    assign('ada', NIGHT_12, '2026-01-05'),
    assign('ada', DAY_12, '2026-01-06'),
  ];

  it('refuses to take the middle out of a stretch when the rest after the first part is too short', () => {
    const model = new SolverModel(input(14));
    const [first, middle, last] = roster();
    for (const a of [first!, middle!, last!]) model.add(a);
    model.remove(middle!);
    expect(model.isLegal(0)).toBe(false);
  });

  it('accepts the same removal when 12 hours off is all the rest owed', () => {
    const model = new SolverModel(input(12));
    const [first, middle, last] = roster();
    for (const a of [first!, middle!, last!]) model.add(a);
    model.remove(middle!);
    expect(model.isLegal(0)).toBe(true);
  });
});

describe('locked shifts that already break a hard rule', () => {
  // Only the consecutive-days rule can bind: a per-diem nurse has no contract to run past, and
  // the weekly cap sits above anything seven day 8s reach.
  function input(locked: Assignment[]): SolveInput {
    return solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [
        makeNurse({
          id: 'ada',
          firstName: 'Ada',
          employmentType: 'per_diem',
          fte: 0,
          contractedHoursPerPeriod: 0,
          isChargeEligible: true,
        }),
      ],
      shiftTypes: [DAY_8],
      coverageRequirements: coverageAllWeek(DAY_8, 'RN', 1),
      ruleSet: withRuleParams(defaultRuleSet(UNIT_ID), {
        'max-hours-per-week': { maxHoursPerWeek: 84, overtimeThresholdHours: 84 },
      }),
      assignments: locked,
    });
  }

  const lockedRun = (start: string, prefix: string, first = 0) =>
    assignRun('ada', DAY_8, start, 6, { isLocked: true }).map((a, i) => ({
      ...a,
      id: `${prefix}${first + i}`,
    }));
  const dayOn = (model: SolverModel, date: string) =>
    model.make(0, model.solvableShifts.find((s) => s.date === date)!);

  it('will not stretch a locked six-day run into a seventh day', () => {
    // Mon 5 – Sat 10 is six days against a cap of five.
    const model = new SolverModel(input(lockedRun('2026-01-05', 'L')));
    expect(model.isLegal(0)).toBe(true);
    expect(model.canAdd(0, dayOn(model, '2026-01-04'))).toBe(false);
    expect(model.canAdd(0, dayOn(model, '2026-01-11'))).toBe(false);
    // Sun 11 and Mon 12 off are the two days owed after the run; Tue 13 stands alone.
    expect(model.canAdd(0, dayOn(model, '2026-01-13'))).toBe(true);
  });

  it('will not join two locked runs into one longer run', () => {
    const model = new SolverModel(
      input([...lockedRun('2026-01-05', 'L'), ...lockedRun('2026-01-12', 'L', 6)]),
    );
    expect(model.isLegal(0)).toBe(true);
    // Sun 11 makes Mon 5 – Sat 17 one 13-day run.
    expect(model.canAdd(0, dayOn(model, '2026-01-11'))).toBe(false);
  });
});

describe('a shift short of its floor', () => {
  // Two per-diem charge nurses (no contract, so no hours pressure) and floors only on Mon 5 Jan,
  // so the coverage term is the only thing a roster moves. No census, so no ratio demand.
  function mondayOnly(day: number, night: number): SolveInput {
    return solveInputFrom({
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
        ...(day > 0 ? [coverage(DAY_12, 'RN', day, day, null, isoDate('2026-01-05'))] : []),
        ...(night > 0 ? [coverage(NIGHT_12, 'RN', night, night, null, isoDate('2026-01-05'))] : []),
      ],
    });
  }

  it('prices a shift three short at six times one short', () => {
    const model = new SolverModel(mondayOnly(3, 0));
    const day = model.shiftAt(model.dateIdx.get(isoDate('2026-01-05'))!, DAY_12);
    // Nobody on: 3 short is 1 + 2 + 3 = 6 units of 3,000, plus 3 below target at 60. Nobody is
    // on the shift, so there is no charge nurse to miss.
    expect(model.coveragePenaltyOf(day)).toBe(18_180);
    model.add(assign('ada', DAY_12, '2026-01-05'));
    // Two short: 1 + 2 = 3 units, plus 2 below target. Ada can take charge.
    expect(model.coveragePenaltyOf(day)).toBe(9_120);
  });

  it('would rather run two shifts one short than strip one of them', () => {
    const coverageOf = (roster: Assignment[]) => {
      const model = new SolverModel(mondayOnly(2, 2));
      for (const a of roster) model.add(a);
      return model.breakdown().coverage;
    };
    // Both on the day: the night is two short (3,000 + 6,000) and two below target (120).
    const stripped = coverageOf([
      assign('ada', DAY_12, '2026-01-05'),
      assign('bo', DAY_12, '2026-01-05'),
    ]);
    // One on each: each shift one short (3,000) and one below target (60).
    const spread = coverageOf([
      assign('ada', DAY_12, '2026-01-05'),
      assign('bo', NIGHT_12, '2026-01-05'),
    ]);
    expect(stripped).toBe(9_120);
    expect(spread).toBe(6_120);
  });
});
