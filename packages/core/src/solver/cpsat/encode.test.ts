/**
 * The CP-SAT encoding, checked against the rule engine and the annealer's model — no native
 * binary needed. `CpBuilder.evaluate` fixes the decision variables to a schedule, derives every
 * auxiliary from its definition, checks every constraint and prices the objective.
 *
 * Three kinds of evidence:
 * - hand-worked cases per rule: a pair the rule forbids is forbidden, the neighbouring legal
 *   pattern is not;
 * - legal schedules (the annealer's output, which the rule engine has already judged) satisfy
 *   every encoded constraint — the encoding is not stricter than the rules where it matters;
 * - parity: the encoded objective equals `SolverModel`'s on the same schedule, so CP-SAT and the
 *   annealer are optimising the same thing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, FairnessLedgerEntry, Nurse, Preference } from '../../domain/entities.js';
import { isoDate } from '../../domain/time.js';
import {
  ALL_RULES,
  defaultRuleSet,
  evaluateSchedule,
  hardRuleIdsByScope,
} from '../../rules/registry.js';
import type { RuleSet } from '../../rules/types.js';
import { ScheduleView } from '../../schedule/view.js';
import {
  assign,
  assignRun,
  coverageAllWeek,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  payRate,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  timeOff,
  UNIT_ID,
} from '../../testing/fixtures.js';
import { SolverModel } from '../model.js';
import { Rng } from '../rng.js';
import { solve } from '../solver.js';
import type { SolveInput } from '../types.js';
import { decodeCpsat } from './decode.js';
import { CPSAT_ENCODERS, type CpsatEncoding, decisionsFor, encodeCpsat } from './encode.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** One two-week pay period, Sun 4 – Sat 17 Jan 2026 (the fixture unit's anchor). */
function unit(nurses: Nurse[], options: Partial<SolveScenarioOptions> = {}): SolveInput {
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 1),
      ...coverageAllWeek(NIGHT_12, 'RN', 1),
    ],
    ...options,
  });
}

function withParams(
  ruleId: string,
  params: Record<string, unknown>,
  base: RuleSet = defaultRuleSet(UNIT_ID),
): RuleSet {
  return {
    ...base,
    configs: base.configs.map((c) =>
      c.ruleId === ruleId ? { ...c, params: { ...c.params, ...params } } : c,
    ),
  };
}

/** Weekly caps out of the way, for tests about something else: four 12s is 48h. */
const NO_WEEKLY_CAP = withParams('max-hours-per-week', {
  maxHoursPerWeek: 84,
  overtimeThresholdHours: 84,
});

function evaluate(encoding: CpsatEncoding, assignments: readonly Assignment[]) {
  return encoding.builder.evaluate(decisionsFor(encoding, assignments), encoding.objectiveScale);
}

function hasVariable(encoding: CpsatEncoding, nurseId: string, date: string, shiftTypeId: string) {
  return encoding.shiftVars.some(
    (sv) =>
      sv.nurseId === nurseId && sv.shift.date === date && sv.shift.shiftType.id === shiftTypeId,
  );
}

const ada = () => makeNurse({ id: 'ada', firstName: 'Ada', isChargeEligible: true });

describe('variables', () => {
  it('gives a nurse on approved leave no variable during it', () => {
    const nurse = ada();
    const encoding = encodeCpsat(
      unit([nurse], { timeOff: [timeOff('ada', '2026-01-06', '2026-01-08')] }),
    );
    for (const date of ['2026-01-06', '2026-01-07', '2026-01-08']) {
      expect(hasVariable(encoding, 'ada', date, DAY_12.id)).toBe(false);
    }
    // The night before leave runs into its first morning, so it is off limits too.
    expect(hasVariable(encoding, 'ada', '2026-01-05', NIGHT_12.id)).toBe(false);
    expect(hasVariable(encoding, 'ada', '2026-01-05', DAY_12.id)).toBe(true);
  });

  it('gives a nurse with a locked shift no other variable that day', () => {
    const nurse = ada();
    const pinned = assign('ada', DAY_12, '2026-01-06', { isLocked: true });
    const encoding = encodeCpsat(unit([nurse], { assignments: [pinned] }));
    expect(hasVariable(encoding, 'ada', '2026-01-06', DAY_12.id)).toBe(false);
    expect(hasVariable(encoding, 'ada', '2026-01-06', NIGHT_12.id)).toBe(false);
    expect(hasVariable(encoding, 'ada', '2026-01-07', DAY_12.id)).toBe(true);
  });
});

describe('rest and overlap', () => {
  it('forbids a 19:00–07:00 night followed by a 07:00 day (0 hours of rest)', () => {
    const encoding = encodeCpsat(unit([ada()]));
    const turnaround = [assign('ada', NIGHT_12, '2026-01-05'), assign('ada', DAY_12, '2026-01-06')];
    expect(evaluate(encoding, turnaround).violated.join('\n')).toMatch(/rest/);
  });

  it('allows back-to-back nights (12 hours of rest)', () => {
    const encoding = encodeCpsat(unit([ada()]));
    const nights = [assign('ada', NIGHT_12, '2026-01-05'), assign('ada', NIGHT_12, '2026-01-06')];
    expect(evaluate(encoding, nights).violated).toEqual([]);
  });

  it('judges nights across the spring DST weekend with the same 12 hours as any other week', () => {
    // US clocks go forward on Sun 8 Mar 2026. A night Saturday ends 07:00 Sunday; the next night
    // starts 19:00 Sunday: 12 wall-clock hours, exactly the minimum here — not the 11 an instant
    // subtraction would give.
    const input = solveInputFrom({
      startDate: isoDate('2026-03-01'),
      endDate: isoDate('2026-03-14'),
      nurses: [ada()],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: coverageAllWeek(NIGHT_12, 'RN', 1),
      ruleSet: withParams('min-rest-between-shifts', { minRestHours: 12 }),
    });
    const encoding = encodeCpsat(input);
    const nights = [assign('ada', NIGHT_12, '2026-03-07'), assign('ada', NIGHT_12, '2026-03-08')];
    expect(evaluate(encoding, nights).violated).toEqual([]);
  });

  it('forbids a shift the rest rule would flag against the published lookback tail', () => {
    const lastNight = assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' });
    const encoding = encodeCpsat(unit([ada()], { priorAssignments: [lastNight] }));
    const morning = [assign('ada', DAY_12, '2026-01-04')];
    expect(evaluate(encoding, morning).violated.join('\n')).toMatch(/rest/);
  });
});

describe('consecutive shifts', () => {
  const four = withParams('max-consecutive-shifts', { maxConsecutiveShifts: 4 }, NO_WEEKLY_CAP);

  it('allows four days in a row when the limit is four', () => {
    const encoding = encodeCpsat(unit([ada()], { ruleSet: four }));
    expect(evaluate(encoding, assignRun('ada', DAY_12, '2026-01-05', 4)).violated).toEqual([]);
  });

  it('forbids the fifth', () => {
    const encoding = encodeCpsat(unit([ada()], { ruleSet: four }));
    const five = assignRun('ada', DAY_12, '2026-01-05', 5);
    expect(evaluate(encoding, five).violated.join('\n')).toMatch(/consecutive/);
  });

  it('forbids a fourth night when the night limit is three', () => {
    const encoding = encodeCpsat(unit([ada()]));
    const nights = assignRun('ada', NIGHT_12, '2026-01-05', 4);
    expect(evaluate(encoding, nights).violated.join('\n')).toMatch(/night/);
  });

  it('allows four nights after a day shift, because the stretch is not all nights', () => {
    // Day Mon (ends 19:00) then nights Tue–Fri: a five-day stretch, within the limit of five, and
    // the night limit only counts stretches made entirely of nights. A window over the four
    // night-days alone would wrongly forbid it.
    const encoding = encodeCpsat(unit([ada()], { ruleSet: NO_WEEKLY_CAP }));
    const pattern = [
      assign('ada', DAY_12, '2026-01-05'),
      ...assignRun('ada', NIGHT_12, '2026-01-06', 4),
    ];
    expect(evaluate(encoding, pattern).violated).toEqual([]);
  });

  it('requires two days off after a maximum-length stretch', () => {
    const encoding = encodeCpsat(unit([ada()], { ruleSet: four }));
    // Mon–Thu worked (a full stretch of four), Fri off, back on Saturday: one day off, two needed.
    const tooSoon = [
      ...assignRun('ada', DAY_12, '2026-01-05', 4),
      assign('ada', DAY_12, '2026-01-10'),
    ];
    expect(evaluate(encoding, tooSoon).violated.join('\n')).toMatch(/days off/);
    const rested = [
      ...assignRun('ada', DAY_12, '2026-01-05', 4),
      assign('ada', DAY_12, '2026-01-11'),
    ];
    expect(evaluate(encoding, rested).violated).toEqual([]);
  });
});

describe('hours', () => {
  it('counts a shift in the lookback tail toward the first work week', () => {
    // A Wednesday-start work week straddles the period boundary: Wed 31 Dec – Tue 6 Jan.
    const ruleSet = withParams('max-hours-per-week', { workWeekStartsOn: 3 });
    const tail = assignRun('ada', DAY_12, '2025-12-31', 3, { periodId: 'prev' });
    const encoding = encodeCpsat(unit([ada()], { ruleSet, priorAssignments: tail }));
    // 36h in the tail + 12h on Mon 5 Jan = 48h > the 40h overtime threshold, never authorised.
    const monday = [assign('ada', DAY_12, '2026-01-05')];
    expect(evaluate(encoding, monday).violated.join('\n')).toMatch(/week/);
    // The same Monday with no tail is 12h — fine.
    const fresh = encodeCpsat(unit([ada()], { ruleSet }));
    expect(evaluate(fresh, monday).violated).toEqual([]);
  });

  it('caps a pay period at the contract plus its tolerance', () => {
    // 72h contract + 4h tolerance = 76h per pay period: six 12s (72h) fine, seven (84h) not.
    // Spread Mon/Wed/Fri so no weekly cap or stretch rule is what trips.
    const ruleSet = withParams('max-hours-per-week', {
      maxHoursPerWeek: 60,
      overtimeThresholdHours: 60,
    });
    const encoding = encodeCpsat(unit([ada()], { ruleSet }));
    const days = [
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-11',
      '2026-01-13',
      '2026-01-15',
    ];
    const six = days.map((d) => assign('ada', DAY_12, d));
    expect(evaluate(encoding, six).violated).toEqual([]);
    const seven = [...six, assign('ada', DAY_12, '2026-01-17')];
    expect(evaluate(encoding, seven).violated.join('\n')).toMatch(/pay period/);
  });
});

describe('agreement with the rule engine', () => {
  it('calls a random schedule illegal exactly when the rule engine does', () => {
    // Mixed 8/12-hour shifts, on-call, a lookback tail: hundreds of random rosters, each judged
    // twice — by the encoded constraints and by the real nurse-scope hard rules.
    const nurses = [ada(), makeNurse({ id: 'bo', firstName: 'Bo', contractedHoursPerPeriod: 48 })];
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses,
      shiftTypes: [DAY_12, NIGHT_12, DAY_8, EVENING_8, ON_CALL],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ...coverageAllWeek(DAY_8, 'RN', 1),
        ...coverageAllWeek(EVENING_8, 'RN', 1),
        ...coverageAllWeek(ON_CALL, 'RN', 1),
      ],
      priorAssignments: [assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' })],
    });
    const encoding = encodeCpsat(input);
    const model = encoding.solverModel;
    const rng = new Rng(7);
    const byNurseDay = new Map<string, typeof encoding.shiftVars>();
    for (const sv of encoding.shiftVars) {
      const key = `${sv.nurseId}|${sv.shift.dateIdx}`;
      byNurseDay.set(key, [...(byNurseDay.get(key) ?? []), sv]);
    }
    let illegal = 0;
    for (let trial = 0; trial < 400; trial++) {
      const density = 0.2 + 0.6 * rng.nextFloat();
      const chosen = [...byNurseDay.values()].flatMap((options) =>
        rng.chance(density) ? [options[rng.nextInt(0, options.length - 1)]!] : [],
      );
      const assignments = chosen.map((sv) => assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
      const view = new ScheduleView({
        period: input.period,
        assignments,
        priorAssignments: input.priorAssignments,
        nurses: model.nurses,
        shiftTypes: model.shiftTypes,
      });
      const ruleViolations = evaluateSchedule(view, input.ruleSet, model.ctx, {
        only: hardRuleIdsByScope(input.ruleSet, 'nurse'),
      }).hardViolations.filter((v) => v.code !== 'under_contracted_hours');
      const encoded = evaluate(encoding, assignments).violated;
      if (ruleViolations.length > 0) illegal++;
      const verdict = `trial ${trial}: rules say ${ruleViolations.map((v) => v.message).join(' | ') || 'legal'}; encoding says ${encoded.join(' | ') || 'legal'}`;
      expect(encoded.length === 0, verdict).toBe(ruleViolations.length === 0);
    }
    // The generator must produce both kinds, or the agreement proves nothing.
    expect(illegal).toBeGreaterThan(50);
    expect(illegal).toBeLessThan(390);
  });
});

describe('every rule has an encoding', () => {
  it('covers every registered rule, so a new rule cannot be silently ignored by CP-SAT', () => {
    const missing = ALL_RULES.map((r) => r.id).filter((id) => CPSAT_ENCODERS[id] === undefined);
    expect(missing).toEqual([]);
  });

  it('refuses to encode when an enabled hard rule has no encoder, naming it', () => {
    const { 'min-rest-between-shifts': _dropped, ...partial } = CPSAT_ENCODERS;
    expect(() => encodeCpsat(unit([ada()]), { encoders: partial })).toThrow(
      /Minimum rest between shifts/,
    );
  });
});

describe('parity with the annealer', () => {
  function history(nurseId: string, nights: number, weekends: number): FairnessLedgerEntry {
    return {
      id: `ledger-${nurseId}`,
      nurseId,
      periodId: 'prev',
      periodStart: isoDate('2025-12-21'),
      nightShifts: nights,
      weekendsWorked: weekends,
      holidaysWorked: 0,
      onCallShifts: 1,
      undesirableShifts: 1,
      requestsApproved: 0,
      requestsDenied: 0,
      callOutsCovered: 0,
      totalHours: 72,
      overtimeHours: 4,
      preferenceHitRate: 1,
    };
  }

  /** A mixed 8/12-hour unit with everything priced: preferences, history, pay, a locked shift. */
  function richInput(): SolveInput {
    const nurses = Array.from({ length: 7 }, (_, i) =>
      makeNurse({
        isChargeEligible: i % 2 === 0,
        isNovice: i === 5,
        contractedHoursPerPeriod: i === 6 ? 0 : i === 4 ? 48 : 72,
        employmentType: i === 6 ? 'per_diem' : 'full_time',
        seniorityDate: isoDate(`20${10 + i}-01-01`),
      }),
    );
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
      { id: 'p4', nurseId: nurses[3]!.id, kind: 'avoid_weekday', weekday: 3, weight: 2 },
    ];
    return solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-24'),
      nurses,
      shiftTypes: [DAY_12, NIGHT_12, DAY_8, EVENING_8, ON_CALL],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 2, 3),
        ...coverageAllWeek(NIGHT_12, 'RN', 1, 2),
        ...coverageAllWeek(EVENING_8, 'RN', 0, 1),
        ...coverageAllWeek(ON_CALL, 'RN', 0, 1),
      ],
      holidays: [
        { id: 'h1', unitId: UNIT_ID, date: isoDate('2026-01-19'), name: 'MLK Day', isMajor: true },
      ],
      preferences,
      ledgerHistory: nurses.slice(0, 4).map((n, i) => history(n.id, i * 2, i)),
      assignments: [
        assign(nurses[0]!.id, DAY_12, '2026-01-07', { isLocked: true, isCharge: true }),
      ],
      priorAssignments: [assign(nurses[1]!.id, NIGHT_12, '2026-01-03', { periodId: 'prev' })],
      timeOff: [timeOff(nurses[2]!.id, '2026-01-12', '2026-01-14')],
      cost: {
        payRates: [payRate(52), payRate(61, { nurseId: nurses[3]!.id })],
        differentials: [],
        overtimeRules: [],
      },
    });
  }

  /** The encoded objective of a schedule next to what `SolverModel` makes of the same schedule. */
  function both(input: SolveInput, assignments: readonly Assignment[]) {
    const encoding = encodeCpsat(input);
    const evaluation = evaluate(encoding, assignments);
    const model = new SolverModel(input);
    for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
    return { evaluation, expected: model.breakdown().total };
  }

  it("accepts the annealer's legal schedules and prices them the same, seed after seed", () => {
    const input = richInput();
    for (const seed of [1, 2, 3]) {
      const report = solve(input, { seed, maxIterations: 4000 });
      const { evaluation, expected } = both(input, report.assignments);
      expect(evaluation.violated).toEqual([]);
      // Integer scaling rounds each coefficient to 1/1000 point and each hour target to 0.01h.
      expect(evaluation.objective).toBeCloseTo(expected, 0);
    }
  });

  it('prices an empty schedule — every floor short — the same', () => {
    const input = richInput();
    const locked = input.assignments.filter((a) => a.isLocked);
    const { evaluation, expected } = both(input, locked);
    expect(evaluation.violated).toEqual([]);
    expect(evaluation.objective).toBeCloseTo(expected, 0);
  });
});

describe('decoding', () => {
  it('refuses a solution that breaks a rule rather than writing it', () => {
    const input = unit([ada()]);
    const encoding = encodeCpsat(input);
    const values = new Array<number>(encoding.builder.variableCount).fill(0);
    for (const sv of encoding.shiftVars) {
      const night = sv.shift.date === '2026-01-05' && sv.shift.shiftType.id === NIGHT_12.id;
      const day = sv.shift.date === '2026-01-06' && sv.shift.shiftType.id === DAY_12.id;
      if (night || day) values[sv.variable] = 1;
    }
    expect(() => decodeCpsat(input, encoding, values)).toThrow(/ada.*2026-01-06|2026-01-06.*ada/i);
  });

  it('turns a solution into the same schedule the values describe', () => {
    const input = unit([ada()]);
    const encoding = encodeCpsat(input);
    const values = new Array<number>(encoding.builder.variableCount).fill(0);
    for (const sv of encoding.shiftVars) {
      if (sv.shift.date === '2026-01-05' && sv.shift.shiftType.id === DAY_12.id)
        values[sv.variable] = 1;
    }
    const model = decodeCpsat(input, encoding, values);
    expect(model.assignments().map((a) => `${a.date} ${a.shiftTypeId}`)).toEqual([
      `2026-01-05 ${DAY_12.id}`,
    ]);
  });
});
