import { beforeEach, describe, expect, it } from 'vitest';

import type { Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  coverage,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  payRate,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { analyseConflicts, selectAutoResolutions, timeOffImpact } from './analyse.js';
import { type ConflictInput, DEFAULT_AUTO_RESOLVE_POLICY } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const SAT = '2026-01-10';
const NIGHT_ID = `understaffing:${SAT}:${NIGHT_12.id}:RN`;

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

const PRICED = {
  payRates: [payRate(50)],
  differentials: [differential('night', 'flat', 4)],
  overtimeRules: [],
};

describe('the report', () => {
  it('summarises hard and soft counts and the total slots short', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const input = weekendUnit([priya, ana], 2, {
      timeOff: [timeOff(ana.id, '2026-01-12', '2026-01-12', { status: 'pending' })],
      assignments: [assign(ana.id, DAY_12, '2026-01-12')],
      coverageRequirements: [
        coverage(NIGHT_12, 'RN', 2, 2, null, isoDate(SAT)),
        coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-12')),
      ],
    });
    const report = analyseConflicts(input);
    expect(report.periodId).toBe('period-1');
    expect(report.summary.hard).toBe(1);
    expect(report.summary.soft).toBe(1);
    expect(report.summary.byKind.understaffing).toBe(1);
    expect(report.summary.byKind.competing_time_off).toBe(1);
    expect(report.summary.hardShortfall).toBe(2);
    expect(report.conflicts[0]!.kind).toBe('understaffing');
    // Every conflict has options, and every option points at a conflict in the report.
    const ids = new Set(report.conflicts.map((c) => c.id));
    expect(report.resolutions.every((r) => ids.has(r.conflictId))).toBe(true);
    for (const id of ids) expect(report.resolutions.some((r) => r.conflictId === id)).toBe(true);
  });

  it('runs twice on the same inputs and produces identical ids and order', () => {
    const nurses = [
      named('Priya', 'Nair'),
      named('Ana', 'Cruz'),
      named('Tom', 'Reed'),
      named('Lee', 'Park'),
    ];
    const input: ConflictInput = {
      ...weekendUnit(nurses, 2, {
        cost: PRICED,
        assignments: [assign(nurses[2]!.id, DAY_12, SAT)],
        timeOff: [timeOff(nurses[3]!.id, SAT, SAT, { status: 'pending' })],
      }),
      budget: { id: 'b', unitId: 'unit-1', periodId: 'period-1', targetDollars: 100 },
    };
    const first = analyseConflicts(input);
    const second = analyseConflicts(input);
    expect(second.conflicts.map((c) => c.id)).toEqual(first.conflicts.map((c) => c.id));
    expect(second.resolutions.map((r) => r.id)).toEqual(first.resolutions.map((r) => r.id));
    expect(second.resolutions.map((r) => r.score)).toEqual(first.resolutions.map((r) => r.score));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('leaves its inputs untouched', () => {
    const priya = named('Priya', 'Nair');
    const input = weekendUnit([priya], 1, {
      timeOff: [timeOff(priya.id, SAT, SAT, { status: 'pending' })],
    });
    const before = JSON.stringify(input);
    analyseConflicts(input);
    timeOffImpact(input, `to-${priya.id}-${SAT}`, 'approved');
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('auto-resolve', () => {
  it('auto-resolve is off by default and returns nothing', () => {
    const priya = named('Priya', 'Nair');
    const report = analyseConflicts(weekendUnit([priya], 1, { cost: PRICED }));
    expect(report.resolutions.some((r) => r.kind === 'assign_available')).toBe(true);
    expect(DEFAULT_AUTO_RESOLVE_POLICY.enabled).toBe(false);
    expect(selectAutoResolutions(report, DEFAULT_AUTO_RESOLVE_POLICY)).toEqual([]);
  });

  it('auto-resolve skips an option that costs more than the threshold', () => {
    const priya = named('Priya', 'Nair');
    const report = analyseConflicts(weekendUnit([priya], 1, { cost: PRICED }));
    // Priya's night is $648; a $500 ceiling rules it out and nothing else qualifies.
    const chosen = selectAutoResolutions(report, {
      enabled: true,
      maxCostDelta: 500,
      maxFairnessDrop: 100,
    });
    expect(chosen).toEqual([]);
  });

  it('auto-resolve takes the top option when it closes the gap within the limits', () => {
    const priya = named('Priya', 'Nair');
    const report = analyseConflicts(weekendUnit([priya], 1, { cost: PRICED }));
    const chosen = selectAutoResolutions(report, {
      enabled: true,
      maxCostDelta: 700,
      maxFairnessDrop: 100,
    });
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.kind).toBe('assign_available');
    expect(chosen[0]!.nurseIds).toEqual([priya.id]);
  });

  it('auto-resolve never commits the same nurse twice on one date', () => {
    const priya = named('Priya', 'Nair');
    // Two one-RN shifts short on Saturday and one nurse: she can only be given one of them.
    const report = analyseConflicts(
      weekendUnit([priya], 1, {
        coverageRequirements: [
          coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(SAT)),
          coverage(DAY_12, 'RN', 1, 1, null, isoDate(SAT)),
        ],
      }),
    );
    expect(report.conflicts).toHaveLength(2);
    const chosen = selectAutoResolutions(report, {
      enabled: true,
      maxCostDelta: 0,
      maxFairnessDrop: 100,
    });
    expect(chosen).toHaveLength(1);
  });

  it('auto-resolve never accepts a shortfall or denies leave on its own', () => {
    const priya = named('Priya', 'Nair');
    const report = analyseConflicts(
      weekendUnit([priya], 1, {
        timeOff: [timeOff(priya.id, SAT, SAT, { status: 'pending' })],
      }),
    );
    expect(report.resolutions.map((r) => r.kind).sort()).toEqual([
      'accept_shortfall',
      'deny_time_off',
    ]);
    const chosen = selectAutoResolutions(report, {
      enabled: true,
      maxCostDelta: 10_000,
      maxFairnessDrop: 100,
    });
    expect(chosen).toEqual([]);
  });
});

describe('auto-resolve and leave clashes', () => {
  it('auto-resolve never lifts a shift off a nurse on leave without a replacement', () => {
    const priya = named('Priya', 'Nair');
    // Priya alone on a one-RN night during her approved leave: the only closing option is to
    // take her off and leave it empty, which a policy must not do on its own.
    const report = analyseConflicts(
      weekendUnit([priya], 1, {
        assignments: [assign(priya.id, NIGHT_12, SAT)],
        timeOff: [timeOff(priya.id, SAT, SAT)],
      }),
    );
    const clash = report.conflicts.find((c) => c.kind === 'scheduled_on_leave');
    expect(clash).toBeDefined();
    const top = report.resolutions.find((r) => r.conflictId === clash!.id);
    expect(top!.closesConflict).toBe(true);
    expect(top!.impact.coverage.delta).toBe(1);
    const chosen = selectAutoResolutions(report, {
      enabled: true,
      maxCostDelta: 10_000,
      maxFairnessDrop: 100,
    });
    expect(chosen).toEqual([]);
  });
});

describe('time-off what-if', () => {
  it('approving the tipping request surfaces the new understaffing in the impact preview', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const priyasNight = assign(priya.id, NIGHT_12, SAT);
    const input = weekendUnit([priya, ana, tom], 2, {
      assignments: [
        priyasNight,
        assign(ana.id, NIGHT_12, SAT),
        assign(priya.id, DAY_12, '2026-01-13'),
      ],
      timeOff: [
        timeOff(priya.id, SAT, '2026-01-11', { status: 'pending' }),
        timeOff(tom.id, '2026-01-11', '2026-01-12', { status: 'pending' }),
      ],
    });

    const impact = timeOffImpact(input, `to-${priya.id}-${SAT}`, 'approved');
    expect(impact.decision).toBe('approved');
    expect(impact.request.id).toBe(`to-${priya.id}-${SAT}`);
    expect(impact.introduced.map((c) => c.id)).toContain(NIGHT_ID);
    expect(impact.introduced.find((c) => c.id === NIGHT_ID)!.magnitude).toBe(1);
    // Only the night inside the requested range is orphaned; Tuesday's day shift is untouched.
    expect(impact.displacedAssignments).toEqual([priyasNight]);
    expect(impact.coverage).toEqual({ hardShortfallBefore: 0, hardShortfallAfter: 1, delta: 1 });
    // Tom's request overlaps the 11th; it is the competition, Priya's own request is not.
    expect(impact.competing.map((r) => r.nurseId)).toEqual([tom.id]);
    // The competing-time-off warning for that night goes away once the decision is made.
    expect(impact.cleared.some((c) => c.kind === 'competing_time_off')).toBe(true);
  });

  it('denying the request orphans nothing and clears the competing warning', () => {
    const priya = named('Priya', 'Nair');
    const input = weekendUnit([priya], 1, {
      assignments: [assign(priya.id, NIGHT_12, SAT)],
      timeOff: [timeOff(priya.id, SAT, SAT, { status: 'pending' })],
    });
    const impact = timeOffImpact(input, `to-${priya.id}-${SAT}`, 'denied');
    expect(impact.displacedAssignments).toEqual([]);
    expect(impact.introduced).toEqual([]);
    expect(impact.cleared.map((c) => c.kind)).toEqual(['competing_time_off']);
    expect(impact.coverage.delta).toBe(0);
  });

  it('refuses an unknown request id loudly', () => {
    const priya = named('Priya', 'Nair');
    expect(() => timeOffImpact(weekendUnit([priya], 1), 'nope', 'approved')).toThrow(/nope/);
  });
});
