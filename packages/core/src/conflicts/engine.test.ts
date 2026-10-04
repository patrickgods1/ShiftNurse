/**
 * The simulation engine's view of a shift inside another: a change to the day 12 can leave the
 * mid 8 inside it without cover, so a simulated change reports that too.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { Rng } from '../solver/rng.js';
import { solve } from '../solver/solver.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  MID_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { ConflictEngine } from './engine.js';

beforeEach(() => {
  resetFixtureCounters();
});

const MON = '2026-01-05';

describe('violations around a shift', () => {
  it('reports the new grad left without cover on the mid 8 when the day 12 loses its RN', () => {
    const lead = makeNurse({ id: 'lead', isChargeEligible: true });
    const newGrad = makeNurse({ id: 'new', isNovice: true });
    const input = solveInputFrom({
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-11'),
      nurses: [lead, newGrad],
      shiftTypes: [DAY_12, NIGHT_12, MID_8],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1, 1),
        ...coverageAllWeek(MID_8, 'RN', 1, 1),
      ],
    });
    const engine = new ConflictEngine(input);
    const onMid = assign('new', MID_8, MON);
    const codes = (state: ReturnType<ConflictEngine['state']>) =>
      state.shiftViolationsAround(isoDate(MON), DAY_12.id).map((v) => v.code);

    const covered = engine.state([assign('lead', DAY_12, MON, { isCharge: true }), onMid], []);
    expect(codes(covered)).not.toContain('all_novice_shift');
    const uncovered = engine.state([onMid], []);
    expect(codes(uncovered)).toContain('all_novice_shift');
  });
});

/**
 * A simulated fix is priced against the state it came from: only the nurses and cells whose
 * shifts or requests differ are re-derived. That must give exactly what pricing the whole
 * period from scratch gives, whatever the change — the oracle here is a fresh state.
 */
describe('pricing a fix against the state it came from', () => {
  it('gives the same shortfall and fairness as pricing the period from scratch', () => {
    const nurses = Array.from({ length: 14 }, (_, i) =>
      makeNurse({ isChargeEligible: i % 3 === 0, contractedHoursPerPeriod: i === 13 ? 0 : 72 }),
    );
    const base = {
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses,
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 3, 4),
        ...coverageAllWeek(NIGHT_12, 'RN', 3, 3),
      ],
    };
    const solved = solve(solveInputFrom(base), { seed: 3, maxIterations: 5000 });
    const leave = nurses.slice(0, 6).map((n, i) =>
      timeOff(n.id, `2026-01-${String(6 + i).padStart(2, '0')}`, '2026-01-12', {
        status: i % 2 ? 'pending' : 'approved',
      }),
    );
    const engine = new ConflictEngine(
      solveInputFrom({ ...base, assignments: solved.assignments, timeOff: leave }),
    );
    const baseline = engine.baseline();
    const rng = new Rng(17);
    for (let step = 0; step < 150; step++) {
      // A fix: drop a shift or two, add one for someone else, maybe decide a request.
      const assignments = [...baseline.assignments];
      for (let k = rng.nextInt(0, 2); k > 0 && assignments.length > 0; k--) {
        assignments.splice(rng.nextInt(0, assignments.length - 1), 1);
      }
      if (rng.chance(0.7)) {
        const nurse = rng.pick(nurses);
        const day = rng.nextInt(4, 17);
        assignments.push(
          assign(
            nurse.id,
            rng.chance() ? DAY_12 : NIGHT_12,
            `2026-01-${String(day).padStart(2, '0')}`,
          ),
        );
      }
      const requests = baseline.timeOff.map((r) =>
        r.status === 'pending' && rng.chance(0.2) ? { ...r, status: 'approved' as const } : r,
      );
      const derived = engine.state(assignments, requests, baseline);
      const fresh = engine.state(assignments, requests);
      expect(derived.hardShortfall(), `step ${step}`).toBe(fresh.hardShortfall());
      expect([...derived.counters()].sort(), `step ${step}`).toEqual([...fresh.counters()].sort());
      expect(derived.fairness().mean, `step ${step}`).toBe(fresh.fairness().mean);
    }
  });
});
