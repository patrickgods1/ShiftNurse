// These run on one complete pay period (Sun Jan 4 – Sat Jan 17, 2026) with contracted nurses
// near their 72 h, so the default hard FTE rule is in play, as on a real unit (review T-08).

import { beforeEach, describe, expect, it } from 'vitest';

import type { Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  coverage,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { detectConflicts } from './detect.js';
import { generateResolutions } from './resolve.js';
import type { ConflictInput, Resolution } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

const SAT = '2026-01-10';
const THU = '2026-01-08';
const NIGHT = `understaffing:${SAT}:${NIGHT_12.id}:RN`;

function payPeriodUnit(nurses: Nurse[], extra: Partial<SolveScenarioOptions> = {}): ConflictInput {
  return solveInputFrom({
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(SAT))],
    ...extra,
  });
}

function named(first: string, last: string, overrides: Partial<Nurse> = {}): Nurse {
  return makeNurse({ firstName: first, lastName: last, isChargeEligible: true, ...overrides });
}

function nightOptions(input: ConflictInput): Resolution[] {
  return generateResolutions(input, detectConflicts(input)).filter((r) => r.conflictId === NIGHT);
}

const ana = () => named('Ana', 'Cruz', { id: 'ana' });
const priya = () => named('Priya', 'Nair', { id: 'priya' });
const tom = () => named('Tom', 'Reed', { id: 'tom' });

/**
 * Ana and Priya at exactly 72 h, both on Thursday's day shift (Priya in charge). Every day shift
 * needs one RN, so each of their other day shifts is at its minimum and Thursday is the only one
 * with an RN to spare — without that floor a day shift nobody needs could give up anyone.
 */
function fullTimers(thuMin: number, thuTarget: number): ConflictInput {
  return payPeriodUnit([ana(), priya()], {
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 1, 1),
      coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(SAT)),
      coverage(DAY_12, 'RN', thuMin, thuTarget, null, isoDate(THU)),
    ],
    assignments: [
      ...['2026-01-04', '2026-01-06', '2026-01-13', '2026-01-15', '2026-01-17'].map((d) =>
        assign('ana', DAY_12, d),
      ),
      assign('ana', DAY_12, THU, { id: 'ana-thu' }),
      ...['2026-01-05', '2026-01-07', '2026-01-12', '2026-01-14', '2026-01-16'].map((d) =>
        assign('priya', DAY_12, d),
      ),
      assign('priya', DAY_12, THU, { isCharge: true }),
    ],
  });
}

/** Tom at 60 h: Mon, Wed of the first week and Mon, Wed, Fri of the second. */
function tomBelowHours(extra: Partial<SolveScenarioOptions> = {}): ConflictInput {
  return payPeriodUnit([tom()], {
    assignments: ['2026-01-05', '2026-01-07', '2026-01-12', '2026-01-14', '2026-01-16'].map((d) =>
      assign('tom', DAY_12, d),
    ),
    ...extra,
  });
}

const thursdayMove = (options: Resolution[]) =>
  options.find(
    (r) =>
      r.kind === 'move_assignment' &&
      r.actions.some((a) => a.type === 'move_assignment' && a.assignmentId === 'ana-thu'),
  );

describe('a short night on a unit whose nurses are at their contracted hours', () => {
  it('moves a nurse off a Thursday with a spare RN onto the empty Saturday night, hours unchanged', () => {
    const options = nightOptions(fullTimers(1, 1));
    const move = thursdayMove(options);
    expect(move).toBeDefined();
    expect(move!.actions).toEqual([
      {
        type: 'move_assignment',
        assignmentId: 'ana-thu',
        toDate: '2026-01-10',
        toShiftTypeId: 'st-n12',
        isCharge: true,
      },
    ]);
    expect(move!.nurseIds).toEqual(['ana']);
    expect(move!.impact.coverage.delta).toBe(-1);
    expect(move!.impact.targetShortfallDelta).toBe(-1);
    expect(move!.closesConflict).toBe(true);
    expect(move!.title).toBe('Move Ana Cruz (RN) from Thu Jan 8 D12 to Sat Jan 10 N12');
    expect(move!.description).toContain(
      'Moves Ana Cruz off Thu Jan 8 D12, which keeps its RN minimum without them, onto ' +
        'Sat Jan 10 N12; their hours are unchanged.',
    );

    // Priya is Thursday's charge nurse: moving her would leave that shift without one.
    const moved = options.filter((r) => r.kind === 'move_assignment').flatMap((r) => r.nurseIds);
    expect(moved).not.toContain('priya');

    // Each is at 72 h with 36 h in the week of Jan 4: a fourth shift makes 48 h, at the cap
    // but not past it, and authorised overtime sits outside the contract ceiling.
    const overtime = options.filter((r) => r.kind === 'authorize_overtime');
    expect(overtime.map((r) => r.nurseIds[0]).sort()).toEqual(['ana', 'priya']);
    expect(options.at(-1)!.kind).toBe('accept_shortfall');
  });

  it('moves a nurse off a shift at its target but above its minimum', () => {
    const move = thursdayMove(nightOptions(fullTimers(1, 2)));
    expect(move).toBeDefined();
    expect(move!.actions[0]).toMatchObject({ type: 'move_assignment', isCharge: true });
    // Thursday falls one below its target of 2 as Saturday reaches its target of 1.
    expect(move!.impact.targetShortfallDelta).toBe(0);
    expect(move!.impact.coverage.delta).toBe(-1);
  });

  it('never moves a nurse off a shift that would drop below its minimum', () => {
    // Two staffed against a minimum of 2: neither may leave Thursday.
    const options = nightOptions(fullTimers(2, 2));
    expect(options.some((r) => r.kind === 'move_assignment')).toBe(false);
  });
});

describe('a short night with a nurse below her hours', () => {
  it('offers a nurse below her hours the night at straight time', () => {
    const options = nightOptions(tomBelowHours());
    const assignTom = options.find((r) => r.kind === 'assign_available' && r.nurseIds[0] === 'tom');
    expect(assignTom?.title).toBe('Assign Tom Reed (RN) — straight time');
  });

  it('offers to deny a pending request so a nurse below her hours can take the night', () => {
    const options = nightOptions(
      tomBelowHours({ timeOff: [timeOff('tom', SAT, SAT, { status: 'pending' })] }),
    );
    expect(options.find((r) => r.kind === 'deny_time_off')).toMatchObject({
      actions: [{ type: 'deny_time_off' }, { type: 'create_assignment' }],
    });
    expect(options.some((r) => r.kind === 'assign_available' && r.nurseIds[0] === 'tom')).toBe(
      false,
    );
  });
});

/**
 * Ana at 84 h: D12 on Sun Jan 4 (locked), Tue 6, Thu 8, then Sun 11, Tue 13, Thu 15 and Sat 17.
 * Nothing needs staffing, so taking her off a shift opens no hole.
 */
function anaPastHerHours(): ConflictInput {
  return payPeriodUnit([ana()], {
    coverageRequirements: [],
    assignments: [
      assign('ana', DAY_12, '2026-01-04', { id: 'ana-sun', isLocked: true }),
      ...['2026-01-06', '2026-01-08', '2026-01-11', '2026-01-13', '2026-01-15', '2026-01-17'].map(
        (d) => assign('ana', DAY_12, d, { id: `ana-${d.slice(-2)}` }),
      ),
    ],
  });
}

const deletedIds = (options: Resolution[]) =>
  options
    .filter((r) => r.kind === 'remove_assignment')
    .flatMap((r) => r.actions.map((a) => (a.type === 'delete_assignment' ? a.assignmentId : '')));

describe('a nurse scheduled past their hours', () => {
  it('offers to take her off one of her shifts, and calls keeping them a decision, not a shortfall', () => {
    const input = anaPastHerHours();
    const conflicts = detectConflicts(input);
    const contract = conflicts.find((c) => c.id === 'fte:over_contracted_hours:ana:2026-01-04');
    // 7 × 12 = 84 h against 72: 12 over.
    expect(contract).toMatchObject({ severity: 'hard', magnitude: 12 });
    // Week of Jan 11: 4 × 12 = 48 h, 8 past 40, nothing authorised.
    expect(
      conflicts.find((c) => c.id === 'fte:unauthorised_overtime:ana:2026-01-11'),
    ).toMatchObject({ severity: 'hard', magnitude: 8 });

    const options = generateResolutions(input, conflicts).filter(
      (r) => r.conflictId === contract!.id,
    );
    // Six unlocked shifts, each of which brings her to 72 h (within 76); the cap keeps four.
    const removals = options.filter((r) => r.kind === 'remove_assignment');
    expect(removals).toHaveLength(4);
    expect(options).toHaveLength(5);
    for (const r of removals) {
      expect(r.closesConflict).toBe(true);
      expect(r.actions).toHaveLength(1);
      expect(r.nurseIds).toEqual(['ana']);
    }
    const deleted = deletedIds(options);
    expect(deleted).toHaveLength(4);
    expect(deleted).not.toContain('ana-sun');
    for (const id of deleted) {
      expect(['ana-06', 'ana-08', 'ana-11', 'ana-13', 'ana-15', 'ana-17']).toContain(id);
    }

    const keep = options.at(-1)!;
    expect(keep.kind).toBe('accept_shortfall');
    expect(keep.id).toBe(`${contract!.id}/accept_shortfall`);
    expect(keep.title).toBe('Keep these hours as they are');
    expect(keep.description).toBe(
      "Leaves Ana Cruz's hours as they are, recorded as a deliberate decision with your reason.",
    );
  });

  it('words the removal as taking her off that one shift', () => {
    const input = anaPastHerHours();
    const options = generateResolutions(input, detectConflicts(input));
    const off17 = options.find(
      (r) =>
        r.conflictId === 'fte:unauthorised_overtime:ana:2026-01-11' &&
        r.id.endsWith('remove_assignment:ana-17'),
    );
    expect(off17?.title).toBe('Take Ana Cruz off Sat Jan 17 D12');
    expect(off17?.description).toContain(
      "Lifts Ana Cruz's Sat Jan 17 D12 to bring their hours back within the limit. " +
        'Leaves no shift short.',
    );
  });

  it('offers only shifts from the week that runs into overtime', () => {
    const input = anaPastHerHours();
    const id = 'fte:unauthorised_overtime:ana:2026-01-11';
    const options = generateResolutions(input, detectConflicts(input)).filter(
      (r) => r.conflictId === id,
    );
    // 48 h in the week of Jan 11; any one of its four shifts off leaves 36 h, within 40.
    const removals = options.filter((r) => r.kind === 'remove_assignment');
    // Jan 11, 13, 15 and 17: the whole overtime week, none of it locked.
    expect(removals).toHaveLength(4);
    for (const r of removals) expect(r.closesConflict).toBe(true);
    for (const deleted of deletedIds(options)) {
      expect(['ana-11', 'ana-13', 'ana-15', 'ana-17']).toContain(deleted);
    }
  });
});
