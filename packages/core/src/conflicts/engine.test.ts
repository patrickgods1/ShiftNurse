/**
 * The simulation engine's view of a shift inside another: a change to the day 12 can leave the
 * mid 8 inside it without cover, so a simulated change reports that too.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  MID_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
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
