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
import {
  assign,
  CRED_ACLS,
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
  timeOff,
} from '../testing/fixtures.js';
import { SolverModel } from './model.js';
import { Rng } from './rng.js';
import type { SolveInput } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** `mid`: add an 11:00–19:00 mid 8 inside the day 12, with an ACLS requirement on it. */
function scenario({ mid = false } = {}): SolveInput {
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
    assignments: [pinned],
    priorAssignments: [prior],
    holidays: [
      { id: 'h1', unitId: 'unit-1', date: isoDate('2026-01-08'), name: 'Test day', isMajor: false },
    ],
  });
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
});

function walk(input: SolveInput, checkEvery = 25): void {
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
      for (const term of [
        'coverage',
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
}

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
