import { beforeEach, describe, expect, it } from 'vitest';

import type { Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  CRED_BLS,
  coverage,
  DAY_12,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  payRate,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { detectConflicts } from './detect.js';
import type { ConflictInput } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/**
 * A thirteen-day period (Mon 5 Jan – Sat 17 Jan 2026) that contains no *complete* pay period,
 * so the FTE rule stays quiet and the staffing tests read cleanly. Saturday 10 January is the
 * weekend under scrutiny.
 */
const SAT = '2026-01-10';

function weekendUnit(nurses: Nurse[], extra: Partial<SolveScenarioOptions> = {}): ConflictInput {
  return solveInputFrom({
    startDate: isoDate('2026-01-05'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      coverage(NIGHT_12, 'RN', 2, 2, null, isoDate(SAT)),
      coverage(DAY_12, 'RN', 1, 1, null, isoDate(SAT)),
    ],
    ...extra,
  });
}

function named(first: string, last: string, overrides: Partial<Nurse> = {}): Nurse {
  return makeNurse({ firstName: first, lastName: last, isChargeEligible: true, ...overrides });
}

describe('staffing conflicts', () => {
  it('flags Saturday night RN short by two when two approvals empty it', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    // Priya and Ana were the Saturday night pair; approving their leave took them off it.
    const input = weekendUnit([priya, ana, tom], {
      assignments: [assign(tom.id, DAY_12, SAT)],
      timeOff: [timeOff(priya.id, SAT, '2026-01-11'), timeOff(ana.id, SAT, '2026-01-11')],
    });

    const conflicts = detectConflicts(input);
    const night = conflicts.find((c) => c.kind === 'understaffing');

    expect(night).toBeDefined();
    expect(night!.id).toBe(`understaffing:${SAT}:${NIGHT_12.id}:RN`);
    expect(night!.severity).toBe('hard');
    expect(night!.magnitude).toBe(2);
    expect(night!.dates).toEqual([SAT]);
    expect(night!.role).toBe('RN');
    expect(night!.timeOffIds.sort()).toEqual(
      [`to-${ana.id}-${SAT}`, `to-${priya.id}-${SAT}`].sort(),
    );
    expect(night!.nurseIds.sort()).toEqual([ana.id, priya.id].sort());
    expect(night!.message).toContain('Sat 10 Jan');
    expect(night!.message).toContain('0 staffed of 2 required');
    expect(night!.message).toContain('Priya Nair');
    // The day shift is covered, so the only staffing conflict is the night.
    expect(
      conflicts.filter((c) => c.kind === 'understaffing' || c.kind === 'ratio_breach'),
    ).toHaveLength(1);
  });

  it('a pending cluster on one weekend shows as competing time off before anyone is approved', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const input = weekendUnit([priya, ana, tom], {
      assignments: [
        assign(priya.id, NIGHT_12, SAT),
        assign(ana.id, NIGHT_12, SAT),
        assign(tom.id, DAY_12, SAT),
      ],
      timeOff: [
        timeOff(priya.id, SAT, '2026-01-11', { status: 'pending' }),
        timeOff(ana.id, SAT, '2026-01-11', { status: 'pending' }),
      ],
    });

    const conflicts = detectConflicts(input);

    // Nothing is decided, so the shift is still fully staffed and nothing is hard.
    expect(conflicts.filter((c) => c.severity === 'hard')).toHaveLength(0);
    const competing = conflicts.filter((c) => c.kind === 'competing_time_off');
    expect(competing).toHaveLength(1);
    const c = competing[0]!;
    expect(c.id).toBe(`competing_time_off:${SAT}:${NIGHT_12.id}:RN`);
    expect(c.severity).toBe('soft');
    expect(c.shiftTypeId).toBe(NIGHT_12.id);
    expect(c.timeOffIds.sort()).toEqual([`to-${ana.id}-${SAT}`, `to-${priya.id}-${SAT}`].sort());
    expect(c.nurseIds.sort()).toEqual([ana.id, priya.id].sort());
    // Approving both would leave nobody on a two-RN floor.
    expect(c.magnitude).toBe(2);
    expect(c.message).toContain('2 pending');
  });

  it('orders hard conflicts before soft, then by how short the shift is', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    const tom = named('Tom', 'Reed');
    const input = weekendUnit([priya, ana, tom], {
      // Night is short by two (nobody), day is short by one (nobody), and Tom's pending
      // request touches a date with no demand, so it produces nothing.
      timeOff: [timeOff(tom.id, '2026-01-12', '2026-01-12', { status: 'pending' })],
    });
    const conflicts = detectConflicts(input);
    expect(conflicts.map((c) => c.id)).toEqual([
      `understaffing:${SAT}:${NIGHT_12.id}:RN`,
      `understaffing:${SAT}:${DAY_12.id}:RN`,
    ]);
  });
});

describe('hours, credentials and budget', () => {
  it('reports a full-timer 24 hours short of contract as a hard FTE conflict', () => {
    const priya = named('Priya', 'Nair');
    // 4 Jan – 17 Jan is exactly one 14-day pay period; four 12-hour days is 48h of 72h.
    const input = solveInputFrom({
      nurses: [priya],
      shiftTypes: [DAY_12],
      assignments: [
        assign(priya.id, DAY_12, '2026-01-05'),
        assign(priya.id, DAY_12, '2026-01-07'),
        assign(priya.id, DAY_12, '2026-01-09'),
        assign(priya.id, DAY_12, '2026-01-11'),
      ],
    });

    const conflicts = detectConflicts(input);
    expect(conflicts).toHaveLength(1);
    const fte = conflicts[0]!;
    expect(fte.kind).toBe('fte');
    expect(fte.severity).toBe('hard');
    expect(fte.magnitude).toBe(24);
    expect(fte.nurseIds).toEqual([priya.id]);
    expect(fte.id).toBe(`fte:under_contracted_hours:${priya.id}:2026-01-04`);
    expect(fte.message).toContain('24h short');
  });

  it('flags the shift a nurse works after their BLS has lapsed, and only that one', () => {
    const priya = named('Priya', 'Nair');
    const input = solveInputFrom({
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-17'),
      nurses: [priya],
      shiftTypes: [DAY_12],
      assignments: [
        assign(priya.id, DAY_12, '2026-01-08'),
        assign(priya.id, DAY_12, SAT),
        assign(priya.id, DAY_12, '2026-01-12'),
      ],
      // Valid through the 10th inclusive; the 12th is the first shift after it lapses.
      nurseCredentials: [nurseCredential(priya.id, CRED_BLS, { expiresOn: isoDate(SAT) })],
    });

    const conflicts = detectConflicts(input);
    expect(conflicts).toHaveLength(1);
    const cred = conflicts[0]!;
    expect(cred.kind).toBe('credential');
    expect(cred.id).toBe(`credential:expired:${priya.id}:${CRED_BLS.id}`);
    expect(cred.dates).toEqual(['2026-01-12']);
    expect(cred.magnitude).toBe(1);
    expect(cred.message).toContain('BLS');
    expect(cred.message).toContain('Priya Nair');
  });

  it('prices the period and reports the dollars over budget', () => {
    const priya = named('Priya', 'Nair');
    const input: ConflictInput = {
      ...solveInputFrom({
        startDate: isoDate('2026-01-05'),
        endDate: isoDate('2026-01-17'),
        nurses: [priya],
        shiftTypes: [DAY_12],
        assignments: [
          assign(priya.id, DAY_12, '2026-01-06'),
          assign(priya.id, DAY_12, '2026-01-08'),
        ],
        cost: { payRates: [payRate(50)], differentials: [], overtimeRules: [] },
      }),
      // Two 12-hour days at $50/h is $1,200 against a $1,000 budget.
      budget: { id: 'b1', unitId: 'unit-1', periodId: 'period-1', targetDollars: 1000 },
    };

    const conflicts = detectConflicts(input);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe('budget');
    expect(conflicts[0]!.severity).toBe('soft');
    expect(conflicts[0]!.magnitude).toBe(200);
    expect(conflicts[0]!.message).toContain('$200');
  });
});

describe('rostered during approved leave', () => {
  it('flags a nurse still rostered on the weekend her leave was approved for', () => {
    const priya = named('Priya', 'Nair');
    const ana = named('Ana', 'Cruz');
    // Leave approved after the draft was built: Priya's Saturday and Sunday shifts are still on it.
    const input = weekendUnit([priya, ana], {
      assignments: [
        assign(priya.id, NIGHT_12, SAT),
        assign(priya.id, DAY_12, '2026-01-11'),
        assign(ana.id, NIGHT_12, SAT),
        assign(ana.id, DAY_12, SAT),
      ],
      timeOff: [timeOff(priya.id, SAT, '2026-01-11')],
    });

    const conflicts = detectConflicts(input);
    const onLeave = conflicts.filter((c) => c.kind === 'scheduled_on_leave');
    expect(onLeave).toHaveLength(1);
    const c = onLeave[0]!;
    expect(c.id).toBe(`scheduled_on_leave:${priya.id}:to-${priya.id}-${SAT}`);
    expect(c.severity).toBe('hard');
    expect(c.nurseIds).toEqual([priya.id]);
    expect(c.timeOffIds).toEqual([`to-${priya.id}-${SAT}`]);
    expect(c.dates).toEqual([SAT, '2026-01-11']);
    expect(c.magnitude).toBe(2);
    expect(c.message).toContain('Priya Nair');
    expect(c.message).toContain('Sat 10 Jan');
    expect(c.message).toContain('Sun 11 Jan');
    // The night is still fully staffed on paper, so no understaffing conflict yet.
    expect(conflicts.some((k) => k.kind === 'understaffing')).toBe(false);
  });
});
