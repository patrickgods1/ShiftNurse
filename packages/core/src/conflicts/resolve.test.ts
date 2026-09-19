import { beforeEach, describe, expect, it } from 'vitest';

import type { Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  CRED_ACLS,
  coverage,
  credentialRequirement,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { detectConflicts } from './detect.js';
import { generateResolutions } from './resolve.js';
import type { Conflict, ConflictInput, Resolution } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const SAT = '2026-01-10';
const NIGHT_ID = `understaffing:${SAT}:${NIGHT_12.id}:RN`;

/** See detect.test.ts: a period with no complete pay period, so only staffing rules speak. */
function weekendUnit(
  nurses: Nurse[],
  nightMin: number,
  extra: Partial<SolveScenarioOptions> = {},
): ConflictInput {
  return solveInputFrom({
    startDate: isoDate('2026-01-05'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [coverage(NIGHT_12, 'RN', nightMin, nightMin, null, isoDate(SAT))],
    ...extra,
  });
}

function named(first: string, last: string, overrides: Partial<Nurse> = {}): Nurse {
  return makeNurse({ firstName: first, lastName: last, isChargeEligible: true, ...overrides });
}

function analyse(input: ConflictInput): { conflicts: Conflict[]; resolutions: Resolution[] } {
  const conflicts = detectConflicts(input);
  return { conflicts, resolutions: generateResolutions(input, conflicts) };
}

function forConflict(resolutions: Resolution[], conflictId: string): Resolution[] {
  return resolutions.filter((r) => r.conflictId === conflictId);
}

describe('who may be offered', () => {
  it('never offers a nurse who would break minimum rest', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    // Ana works Sunday's day shift at 07:00; Saturday night ends at 07:00 Sunday — zero rest.
    const input = weekendUnit([priya, ana], 1, {
      assignments: [assign(ana.id, DAY_12, '2026-01-11')],
    });

    const { resolutions } = analyse(input);
    const options = forConflict(resolutions, NIGHT_ID);
    expect(options.some((r) => r.nurseIds.includes(priya.id))).toBe(true);
    expect(options.some((r) => r.nurseIds.includes(ana.id))).toBe(false);
  });

  it('skips a nurse already on approved leave and one already working that day', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const input = weekendUnit([priya, ana, tom], 1, {
      assignments: [assign(tom.id, DAY_12, SAT)],
      timeOff: [timeOff(ana.id, SAT, SAT)],
    });
    const { resolutions } = analyse(input);
    const assigned = forConflict(resolutions, NIGHT_ID)
      .filter((r) => r.kind === 'assign_available')
      .map((r) => r.nurseIds[0]);
    expect(assigned).toEqual([priya.id]);
  });

  it('offers to deny a pending request when that nurse could then cover the shift', () => {
    const priya = named('Priya', 'Nair');
    const input = weekendUnit([priya], 1, {
      timeOff: [timeOff(priya.id, SAT, '2026-01-11', { status: 'pending' })],
    });
    const { resolutions } = analyse(input);
    const options = forConflict(resolutions, NIGHT_ID);
    // A pending request is not silently scheduled over: the only way to use Priya is to deny it.
    expect(options.some((r) => r.kind === 'assign_available')).toBe(false);
    const deny = options.find((r) => r.kind === 'deny_time_off');
    expect(deny).toBeDefined();
    expect(deny!.actions.map((a) => a.type)).toEqual(['deny_time_off', 'create_assignment']);
    expect(deny!.impact.coverage.delta).toBe(-1);
    expect(deny!.title).toContain('Priya Nair');
  });

  it('moves a nurse off an over-target day shift onto the short night when that is legal', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const input = weekendUnit([priya, ana, tom], 1, {
      coverageRequirements: [
        coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(SAT)),
        coverage(DAY_12, 'RN', 1, 1, null, isoDate(SAT)),
      ],
      // Two on a one-RN day shift: either could move, but Priya is charge and must stay.
      assignments: [assign(priya.id, DAY_12, SAT, { isCharge: true }), assign(ana.id, DAY_12, SAT)],
    });
    const { resolutions } = analyse(input);
    const moves = forConflict(resolutions, NIGHT_ID).filter((r) => r.kind === 'move_assignment');
    expect(moves.map((r) => r.nurseIds[0])).toEqual([ana.id]);
    expect(moves[0]!.impact.coverage.delta).toBe(-1);
    expect(moves[0]!.impact.softViolationsIntroduced).toEqual([]);
  });

  it('fills a missing ACLS slot only with a nurse who actually holds ACLS', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const input = weekendUnit([priya, ana, tom], 1, {
      assignments: [assign(tom.id, NIGHT_12, SAT)],
      shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: NIGHT_12 })],
      nurseCredentials: [nurseCredential(ana.id, CRED_ACLS)],
    });
    const { conflicts, resolutions } = analyse(input);
    const cred = conflicts.find((c) => c.kind === 'credential');
    expect(cred).toBeDefined();
    const adds = forConflict(resolutions, cred!.id).filter((r) => r.kind === 'assign_available');
    expect(adds.map((r) => r.nurseIds[0])).toEqual([ana.id]);
    expect(adds[0]!.closesConflict).toBe(true);
  });
});

describe('pricing and ranking', () => {
  it('prices the overtime option higher than the straight-time one for the same shift', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const input = weekendUnit([priya, ana], 1, {
      // Ana already has 36h Mon–Wed in the week ending Saturday; the night takes her to 48h.
      assignments: [
        assign(ana.id, DAY_12, '2026-01-05'),
        assign(ana.id, DAY_12, '2026-01-06'),
        assign(ana.id, DAY_12, '2026-01-07'),
      ],
      cost: {
        payRates: [payRate(50)],
        differentials: [differential('night', 'flat', 4)],
        overtimeRules: [overtimeRule('weekly', 40)],
      },
    });

    const { resolutions } = analyse(input);
    const options = forConflict(resolutions, NIGHT_ID);
    const straight = options.find((r) => r.kind === 'assign_available');
    const overtime = options.find((r) => r.kind === 'authorize_overtime');
    expect(straight?.nurseIds).toEqual([priya.id]);
    expect(overtime?.nurseIds).toEqual([ana.id]);

    // Priya: 12h × ($50 base + $4 night) = $648.
    expect(straight!.impact.cost.delta).toBe(648);
    expect(straight!.impact.cost.unpriced).toBe(false);
    // Ana: the same $648, plus 8 of the 12 hours fall past 40h in her week, each earning an
    // extra half of the $54 straight rate: 8 × $27 = $216 → $864.
    expect(overtime!.impact.cost.delta).toBe(864);
    const create = overtime!.actions.find((a) => a.type === 'create_assignment');
    expect(create && create.type === 'create_assignment' && create.isOvertime).toBe(true);
    expect(overtime!.title).toContain('overtime');
    expect(straight!.score).toBeGreaterThan(overtime!.score);
    expect(options.indexOf(straight!)).toBeLessThan(options.indexOf(overtime!));
  });

  it('reports the cost delta as unpriced when the nurse has no rate on file', () => {
    const priya = named('Priya', 'Nair');
    const input = weekendUnit([priya], 1, {
      cost: { payRates: [payRate(50, { role: 'LPN' })], differentials: [], overtimeRules: [] },
    });
    const { resolutions } = analyse(input);
    const add = forConflict(resolutions, NIGHT_ID).find((r) => r.kind === 'assign_available');
    expect(add!.impact.cost.unpriced).toBe(true);
    expect(add!.impact.cost.delta).toBe(0);
  });

  it('accepting the shortfall is always the last option', () => {
    const nurses = [
      named('Priya', 'Nair'),
      named('Ana', 'Cruz'),
      named('Tom', 'Reed'),
      named('Lee', 'Park'),
    ];
    const input = weekendUnit(nurses, 2, {
      coverageRequirements: [
        coverage(NIGHT_12, 'RN', 2, 2, null, isoDate(SAT)),
        coverage(DAY_12, 'RN', 1, 1, null, isoDate(SAT)),
      ],
      timeOff: [timeOff(nurses[3]!.id, SAT, SAT, { status: 'pending' })],
    });
    const { conflicts, resolutions } = analyse(input);
    expect(conflicts.length).toBeGreaterThan(1);
    for (const conflict of conflicts) {
      const options = forConflict(resolutions, conflict.id);
      expect(options.filter((r) => r.kind === 'accept_shortfall')).toHaveLength(1);
      expect(options[options.length - 1]!.kind).toBe('accept_shortfall');
      expect(options[options.length - 1]!.actions).toEqual([
        { type: 'accept_shortfall', conflictId: conflict.id },
      ]);
    }
  });

  it('caps the options per conflict, keeping the best and the shortfall', () => {
    const nurses = Array.from({ length: 8 }, (_, i) => named(`N${i}`, 'Test'));
    const input = weekendUnit(nurses, 1);
    const conflicts = detectConflicts(input);
    const capped = generateResolutions(input, conflicts, { maxPerConflict: 3 });
    const options = forConflict(capped, NIGHT_ID);
    expect(options).toHaveLength(3);
    expect(options[2]!.kind).toBe('accept_shortfall');
    const scores = options.slice(0, 2).map((r) => r.score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]!);
  });

  it('over-approving PTO on one weekend surfaces ranked options with real deltas', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const lee = named('Lee', 'Park');
    const kim = named('Kim', 'Osei');
    const input = weekendUnit([priya, ana, tom, lee, kim], 2, {
      // Priya and Ana held the Saturday night; both approvals went through and emptied it.
      timeOff: [timeOff(priya.id, SAT, '2026-01-11'), timeOff(ana.id, SAT, '2026-01-11')],
      // Kim already worked Friday night, so Saturday is her second night and second weekend day.
      assignments: [assign(kim.id, NIGHT_12, '2026-01-09'), assign(tom.id, DAY_12, '2026-01-07')],
      cost: {
        payRates: [payRate(50), payRate(65, { nurseId: lee.id })],
        differentials: [differential('night', 'flat', 4)],
        overtimeRules: [overtimeRule('weekly', 40)],
      },
    });

    const { conflicts, resolutions } = analyse(input);
    const night = conflicts.find((c) => c.id === NIGHT_ID);
    expect(night).toBeDefined();
    expect(night!.magnitude).toBe(2);
    expect(night!.timeOffIds).toHaveLength(2);

    const options = forConflict(resolutions, NIGHT_ID);
    const real = options.filter((r) => r.kind !== 'accept_shortfall');
    expect(real.length).toBeGreaterThanOrEqual(3);
    // Every real option closes one of the two slots.
    for (const r of real) {
      expect(r.impact.coverage.hardShortfallBefore).toBe(2);
      expect(r.impact.coverage.hardShortfallAfter).toBe(1);
      expect(r.impact.coverage.delta).toBe(-1);
      expect(r.impact.cost.delta).toBeGreaterThan(0);
      expect(r.impact.cost.unpriced).toBe(false);
      expect(r.description).toContain('$');
    }
    expect(real.some((r) => r.impact.fairness.delta !== 0)).toBe(true);
    expect(real.some((r) => r.impact.fairness.affected.length > 0)).toBe(true);
    // Lee is the dear one: 12 × ($65 + $4) = $828 against $648 for the others.
    const lees = real.find((r) => r.nurseIds[0] === lee.id);
    expect(lees!.impact.cost.delta).toBe(828);
    // Ranked best first, shortfall last.
    for (let i = 1; i < real.length; i++) {
      expect(real[i - 1]!.score).toBeGreaterThanOrEqual(real[i]!.score);
    }
    expect(options[options.length - 1]!.kind).toBe('accept_shortfall');
    // The two on approved leave are never offered back onto the shift they were released from.
    expect(real.some((r) => r.nurseIds.includes(priya.id) || r.nurseIds.includes(ana.id))).toBe(
      false,
    );
  });

  it('ranks the deny options of a competing cluster by how much each one saves', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const input = weekendUnit([priya, ana], 2, {
      assignments: [assign(priya.id, NIGHT_12, SAT), assign(ana.id, NIGHT_12, SAT)],
      timeOff: [
        timeOff(priya.id, SAT, '2026-01-11', { status: 'pending' }),
        timeOff(ana.id, SAT, '2026-01-11', { status: 'pending' }),
      ],
    });
    const { conflicts, resolutions } = analyse(input);
    const competing = conflicts.find((c) => c.kind === 'competing_time_off');
    const options = forConflict(resolutions, competing!.id);
    const denies = options.filter((r) => r.kind === 'deny_time_off');
    expect(denies).toHaveLength(2);
    for (const d of denies) {
      // Measured against "approve everything": denying one of the two keeps one of two slots.
      expect(d.impact.coverage.hardShortfallBefore).toBe(2);
      expect(d.impact.coverage.hardShortfallAfter).toBe(1);
      expect(d.actions).toHaveLength(1);
      expect(d.actions[0]!.type).toBe('deny_time_off');
    }
    expect(options[options.length - 1]!.kind).toBe('accept_shortfall');
  });
});

describe('rostered during approved leave', () => {
  it('offers to take her off the shift, with and without a replacement', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const priyasNight = assign(priya.id, NIGHT_12, SAT);
    const input = weekendUnit([priya, ana, tom], 1, {
      assignments: [priyasNight],
      timeOff: [timeOff(priya.id, SAT, SAT)],
      cost: { payRates: [payRate(50)], differentials: [], overtimeRules: [] },
    });
    const { conflicts, resolutions } = analyse(input);
    const conflict = conflicts.find((c) => c.kind === 'scheduled_on_leave');
    expect(conflict).toBeDefined();
    const options = forConflict(resolutions, conflict!.id);

    const deleteOnly = options.find(
      (r) => r.actions.length === 1 && r.actions[0]!.type === 'delete_assignment',
    );
    expect(deleteOnly).toBeDefined();
    expect(deleteOnly!.actions).toEqual([
      { type: 'delete_assignment', assignmentId: priyasNight.id },
    ]);
    // Taking her off leaves the one-RN night empty, and saves her $600.
    expect(deleteOnly!.impact.coverage.delta).toBe(1);
    expect(deleteOnly!.impact.cost.delta).toBe(-600);
    expect(deleteOnly!.closesConflict).toBe(true);
    expect(deleteOnly!.title).toContain('Priya Nair');

    const replacements = options.filter((r) => r.actions.length === 2);
    expect(replacements.map((r) => r.nurseIds[0]).sort()).toEqual([ana.id, tom.id].sort());
    for (const r of replacements) {
      expect(r.actions[0]).toEqual({ type: 'delete_assignment', assignmentId: priyasNight.id });
      expect(r.actions[1]!.type).toBe('create_assignment');
      expect(r.kind).toBe('assign_available');
      expect(r.impact.coverage.delta).toBe(0);
      expect(r.impact.cost.delta).toBe(0);
      expect(r.closesConflict).toBe(true);
      expect(r.score).toBeGreaterThan(deleteOnly!.score);
    }
    expect(options.some((r) => r.kind === 'move_assignment')).toBe(false);
    expect(options[options.length - 1]!.kind).toBe('accept_shortfall');
  });
});
