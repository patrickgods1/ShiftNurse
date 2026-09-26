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
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
} from '../testing/fixtures.js';
import { SolverModel } from './model.js';
import { Rng } from './rng.js';
import type { SolveInput } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

function scenario(): SolveInput {
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
    ],
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
    const input = scenario();
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

      if (step % 25 !== 0) continue;
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
    expect(checked).toBe(24);
    expect(model.unlocked.length).toBeGreaterThan(10);
  });
});
