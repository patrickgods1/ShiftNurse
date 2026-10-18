import { beforeEach, describe, expect, it } from 'vitest';

import type { Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  CRED_ACLS,
  census,
  coverage,
  credentialRequirement,
  DAY_12,
  differential,
  MID_8,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  TIER_ROUTINE,
  timeOff,
} from '../testing/fixtures.js';
import { detectConflicts } from './detect.js';
import { ConflictEngine } from './engine.js';
import { collectViolations } from './resolution-score.js';
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

describe('charge on the offered shift', () => {
  const chargeOffered = (shiftType: typeof DAY_12) => {
    const priya = named('Priya', 'Nair');
    const input = solveInputFrom({
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-17'),
      nurses: [priya],
      shiftTypes: [DAY_12, NIGHT_12, MID_8],
      coverageRequirements: [coverage(shiftType, 'RN', 1, 1, null, isoDate(SAT))],
    });
    const { resolutions } = analyse(input);
    const create = forConflict(resolutions, `understaffing:${SAT}:${shiftType.id}:RN`)
      .flatMap((r) => r.actions)
      .find((a) => a.type === 'create_assignment');
    return create?.type === 'create_assignment' ? create.isCharge : undefined;
  };

  it('makes a charge-eligible nurse charge of an empty day 12, but not of a mid 8', () => {
    expect(chargeOffered(DAY_12)).toBe(true);
    expect(chargeOffered(MID_8)).toBe(false);
  });
});

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
    expect(deny).toMatchObject({
      actions: [{ type: 'deny_time_off' }, { type: 'create_assignment' }],
      impact: { coverage: { delta: -1 } },
      title: expect.stringContaining('Priya Nair'),
    });
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
    // Nobody is on the night, so Ana (charge-eligible) takes charge of it.
    expect(moves[0]!.actions[0]).toMatchObject({ type: 'move_assignment', isCharge: true });
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
      // Each of Ana's day shifts is its floor, so moving her to the night is not on offer.
      coverageRequirements: [
        coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(SAT)),
        ...['2026-01-05', '2026-01-06', '2026-01-07'].map((d) =>
          coverage(DAY_12, 'RN', 1, 1, null, isoDate(d)),
        ),
      ],
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
    expect(straight!.impact.cost.pessimisticDelta).toBe(648);
    // Ana: the same $648, plus 8 of the 12 hours fall past 40h in her week, each earning an
    // extra half of the $54 straight rate: 8 × $27 = $216 → $864.
    expect(overtime!.impact.cost.delta).toBe(864);
    const create = overtime!.actions.find((a) => a.type === 'create_assignment');
    expect(create && create.type === 'create_assignment' && create.isOvertime).toBe(true);
    expect(overtime!.title).toContain('overtime');
    expect(straight!.title).toBe('Assign Priya Nair (RN) — straight time');
    expect(overtime!.title).toBe('Assign Ana Cruz (RN) — authorised overtime');
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
    // Ranked at the unit's dearest rate on file: 12h × the $50 LPN rate.
    expect(add!.impact.cost.pessimisticDelta).toBe(600);
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

  it('calls a budget overrun an overrun, not a shortfall', () => {
    const priya = named('Priya', 'Nair');
    const input: ConflictInput = {
      ...weekendUnit([priya], 0, {
        coverageRequirements: [],
        assignments: [
          assign(priya.id, DAY_12, '2026-01-06'),
          assign(priya.id, DAY_12, '2026-01-08'),
        ],
        cost: { payRates: [payRate(50)], differentials: [], overtimeRules: [] },
      }),
      // Two 12-hour days at $50/h is $1,200 against a $1,000 budget: $200 over.
      budget: { id: 'b1', unitId: 'unit-1', periodId: 'period-1', targetDollars: 1000 },
    };
    const { conflicts, resolutions } = analyse(input);
    const budget = conflicts.find((c) => c.kind === 'budget')!;
    const options = forConflict(resolutions, budget.id);
    expect(options).toHaveLength(1);
    expect(options[0]!.kind).toBe('accept_shortfall');
    expect(options[0]!.id).toBe(`${budget.id}/accept_shortfall`);
    expect(options[0]!.title).toBe('Accept the overrun');
    expect(options[0]!.description).toContain('$200 over budget');
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
      // Kim's Friday night and Tom's Wednesday day are their shifts' floors, so neither can be
      // moved to Saturday at no cost; every option here is a paid addition.
      coverageRequirements: [
        coverage(NIGHT_12, 'RN', 2, 2, null, isoDate(SAT)),
        coverage(NIGHT_12, 'RN', 1, 1, null, isoDate('2026-01-09')),
        coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-07')),
      ],
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
    expect(night).toMatchObject({
      magnitude: 2,
      timeOffIds: [expect.any(String), expect.any(String)],
    });

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
    expect(deleteOnly).toMatchObject({
      actions: [{ type: 'delete_assignment', assignmentId: priyasNight.id }],
    });
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

describe('a licensed-nurse ratio pooling RNs and LVNs', () => {
  it('offers an idle LVN for a pooled shortfall, and names the LVN on leave behind it', () => {
    resetFixtureCounters();
    const rn1 = makeNurse({ id: 'rn1', isChargeEligible: true });
    const rn2 = makeNurse({ id: 'rn2' });
    const lvnOn = makeNurse({ id: 'lvn-on', role: 'LPN' });
    const lvnLeave = makeNurse({ id: 'lvn-leave', role: 'LPN' });
    const lvnFree = makeNurse({ id: 'lvn-free', role: 'LPN', firstName: 'Lu', lastName: 'Tran' });
    const SAT = isoDate('2026-01-10');
    // 20 patients at a licensed 1:5, half RNs: four licensed, two RNs. Two RNs and one LVN are
    // on, the second LVN is on approved leave: one licensed nurse short.
    const input: ConflictInput = solveInputFrom({
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-17'),
      nurses: [rn1, rn2, lvnOn, lvnLeave, lvnFree],
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
      censusForecasts: [census(SAT, DAY_12, { [TIER_ROUTINE.id]: 20 })],
      assignments: [
        assign('rn1', DAY_12, SAT, { isCharge: true }),
        assign('rn2', DAY_12, SAT),
        assign('lvn-on', DAY_12, SAT),
      ],
      timeOff: [timeOff('lvn-leave', SAT, SAT)],
    });
    const conflicts = detectConflicts(input);
    const pool = conflicts.find((c) => c.kind === 'ratio_breach' && c.role === 'licensed');
    expect(pool).toBeDefined();
    expect(pool!.nurseIds).toContain('lvn-leave');
    const offers = generateResolutions(input, conflicts)
      .filter((r) => r.conflictId === pool!.id && r.kind === 'assign_available')
      .flatMap((r) => r.nurseIds);
    expect(offers).toContain('lvn-free');
  });
});

describe('a nurse already past a limit', () => {
  const kim = () =>
    makeNurse({
      id: 'kim',
      firstName: 'Kim',
      lastName: 'Test',
      employmentType: 'per_diem',
      contractedHoursPerPeriod: 0,
      fte: 0,
      isChargeEligible: true,
    });
  // Five locked days in the week of Sun Jan 4: 60h against a 48h cap and a 40h overtime line.
  const kimsWeek = ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-08', '2026-01-09'].map((d) =>
    assign('kim', DAY_12, d, { isLocked: true, isCharge: true }),
  );
  const weeklyOvertimePay = {
    payRates: [payRate(50)],
    differentials: [],
    overtimeRules: [overtimeRule('weekly', 40)],
  };

  it('never offers more hours to a per-diem nurse already over the weekly cap', () => {
    const input = solveInputFrom({
      nurses: [kim()],
      shiftTypes: [DAY_12, NIGHT_12],
      assignments: kimsWeek,
      coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-10'))],
      cost: weeklyOvertimePay,
    });
    const { resolutions } = analyse(input);
    const options = forConflict(resolutions, `understaffing:2026-01-10:${DAY_12.id}:RN`);
    // Saturday makes her week 72h: 24 over the 48h cap instead of 12.
    expect(options.map((r) => r.kind)).toEqual(['accept_shortfall']);
  });

  it('still offers that nurse a shift in a week she is not over', () => {
    const input = solveInputFrom({
      nurses: [kim()],
      shiftTypes: [DAY_12, NIGHT_12],
      assignments: kimsWeek,
      coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-11'))],
      cost: weeklyOvertimePay,
    });
    const { resolutions } = analyse(input);
    const adds = forConflict(resolutions, `understaffing:2026-01-11:${DAY_12.id}:RN`).filter(
      (r) => r.kind === 'assign_available',
    );
    expect(adds.map((r) => r.nurseIds[0])).toEqual(['kim']);
    // The week of Jan 11 holds only this 12h: 12 × $50, no overtime.
    expect(adds[0]!.impact.cost.delta).toBe(600);
    expect(adds[0]!.impact.cost.overtimeHoursDelta).toBe(0);
    expect(adds[0]!.title).toBe('Assign Kim Test (RN) — straight time');
  });

  it('says overtime pay when a straight-time shift crosses the pay overtime line', () => {
    const lee = named('Lee', 'Park', { employmentType: 'per_diem', contractedHoursPerPeriod: 0 });
    const input = solveInputFrom({
      nurses: [lee],
      shiftTypes: [DAY_12, NIGHT_12],
      assignments: [
        assign(lee.id, DAY_12, '2026-01-05'),
        assign(lee.id, DAY_12, '2026-01-06'),
        assign(lee.id, DAY_12, '2026-01-07'),
      ],
      coverageRequirements: [coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(SAT))],
      ruleParams: { 'max-hours-per-week': { requireOvertimeAuthorisation: false } },
      cost: weeklyOvertimePay,
    });
    const { resolutions } = analyse(input);
    const add = forConflict(resolutions, NIGHT_ID).find((r) => r.kind === 'assign_available');
    expect(add?.nurseIds).toEqual([lee.id]);
    // 36h + 12h = 48h: 12 × $50 = $600, plus 8h past 40 at a $25 premium = $800.
    expect(add!.impact.cost.delta).toBe(800);
    expect(add!.impact.cost.overtimeHoursDelta).toBe(8);
    expect(add!.title).toBe('Assign Lee Park (RN) — 8h at overtime pay');
  });

  it('warns that a nurse already over a soft weekly cap goes further over it', () => {
    const input = solveInputFrom({
      nurses: [kim()],
      shiftTypes: [DAY_12, NIGHT_12],
      assignments: kimsWeek,
      coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-10'))],
      cost: weeklyOvertimePay,
    });
    // A unit that treats the weekly cap as advisory: the same breach, now a warning.
    const softCap: ConflictInput = {
      ...input,
      ruleSet: {
        ...input.ruleSet,
        configs: input.ruleSet.configs.map((c) =>
          c.ruleId === 'max-hours-per-week' ? { ...c, severityOverride: 'soft' as const } : c,
        ),
      },
    };
    const { resolutions } = analyse(softCap);
    const add = forConflict(resolutions, `understaffing:2026-01-10:${DAY_12.id}:RN`).find(
      (r) => r.kind === 'assign_available',
    );
    expect(add?.nurseIds).toEqual(['kim']);
    // 60h → 72h in the week of Jan 4: 12 → 24 over the 48h cap. A week over the cap reports
    // that alone, not the overtime past 40 as well.
    const worse = add!.impact.softViolationsIntroduced
      .filter((v) => v.ruleId === 'max-hours-per-week')
      .map((v) => [v.code, v.amount])
      .sort();
    expect(worse).toEqual([['over_max_hours', 24]]);
  });
});

describe('a nurse with no pay rate', () => {
  it("ranks a nurse with no pay rate as dear as the unit's highest rate, not as free", () => {
    const priced = makeNurse({ id: 'a-priced', firstName: 'Priced', isChargeEligible: true });
    const unpriced = makeNurse({ id: 'z-unpriced', firstName: 'Unpriced', isChargeEligible: true });
    const input = weekendUnit([priced, unpriced], 1, {
      cost: {
        payRates: [payRate(50, { nurseId: 'a-priced' }), payRate(70, { role: 'LPN' })],
        differentials: [],
        overtimeRules: [],
      },
    });
    const { resolutions } = analyse(input);
    const options = forConflict(resolutions, NIGHT_ID).filter((r) => r.kind === 'assign_available');
    const a = options.find((r) => r.nurseIds[0] === 'a-priced');
    const z = options.find((r) => r.nurseIds[0] === 'z-unpriced');
    // 12h × $50 = $600 for the priced nurse.
    expect(a!.impact.cost.delta).toBe(600);
    expect(a!.impact.cost.pessimisticDelta).toBe(600);
    // No rate: $0 on the books, but ranked at the $70 ceiling: 12h × $70 = $840.
    expect(z!.impact.cost.unpriced).toBe(true);
    expect(z!.impact.cost.delta).toBe(0);
    expect(z!.impact.cost.pessimisticDelta).toBe(840);
    expect(options[0]).toBe(a);
    // Identical but for pay, so the gap is the cost weight on $840 − $600: 0.05 × 240 = 12.
    expect(a!.score - z!.score).toBeCloseTo(12, 6);
  });
});

describe('shortfall priced as Generate prices it', () => {
  it("values a nurse on a shift three short at three slots' worth, and one short at one", () => {
    const priya = named('Priya', 'Nair');
    const WED = '2026-01-14';
    const input = weekendUnit([priya], 3, {
      coverageRequirements: [
        coverage(NIGHT_12, 'RN', 3, 3, null, isoDate(SAT)),
        coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(WED)),
      ],
    });
    const { resolutions } = analyse(input);
    const sat = forConflict(resolutions, NIGHT_ID).find((r) => r.kind === 'assign_available');
    const wed = forConflict(resolutions, `understaffing:${WED}:${NIGHT_12.id}:RN`).find(
      (r) => r.kind === 'assign_available',
    );
    // Saturday: 3 short (3·4/2 = 6) → 2 short (2·3/2 = 3), so −3. Wednesday: 1 → 0, so −1.
    expect(sat!.impact.shortfallPriceDelta).toBe(-3);
    expect(wed!.impact.shortfallPriceDelta).toBe(-1);
    expect(sat!.impact.coverage.delta).toBe(-1);
    expect(wed!.impact.coverage.delta).toBe(-1);
    expect(sat!.impact.targetShortfallDelta).toBe(-1);
    expect(wed!.impact.targetShortfallDelta).toBe(-1);
  });

  it('counts a slot left below its target against the option', () => {
    const priya = named('Priya', 'Nair');
    const input = weekendUnit([priya], 1, {
      coverageRequirements: [coverage(NIGHT_12, 'RN', 1, 2, null, isoDate(SAT))],
    });
    const { resolutions } = analyse(input);
    const add = forConflict(resolutions, NIGHT_ID).find((r) => r.kind === 'assign_available');
    // Two below target → one below; one short of the minimum → none.
    expect(add!.impact.targetShortfallDelta).toBe(-1);
    expect(add!.impact.shortfallPriceDelta).toBe(-1);
  });
});

describe('judging a change once per shift', () => {
  it('reports the new grad alone on the mid 8 once, not once per touched shift', () => {
    const newGrad = makeNurse({ id: 'new', isNovice: true });
    const input = solveInputFrom({
      nurses: [newGrad],
      shiftTypes: [DAY_12, NIGHT_12, MID_8],
      coverageRequirements: [coverage(MID_8, 'RN', 1, 1, null, isoDate('2026-01-05'))],
    });
    const engine = new ConflictEngine(input);
    const mon = isoDate('2026-01-05');
    const assignments = [assign('new', MID_8, '2026-01-05')];
    const state = engine.state(assignments, []);
    // The mid 8 runs inside the day 12, so judging the day 12 also judges the mid 8.
    const found = collectViolations(state, {
      kind: 'move_assignment',
      idSuffix: 'test',
      actions: [],
      assignments,
      timeOff: [],
      touchedNurses: [],
      touchedShifts: [
        { date: mon, shiftTypeId: DAY_12.id },
        { date: mon, shiftTypeId: MID_8.id },
      ],
      nurseIds: [],
      title: '',
      describe: () => '',
    });
    expect(found.filter((v) => v.code === 'all_novice_shift')).toHaveLength(1);
  });
});
