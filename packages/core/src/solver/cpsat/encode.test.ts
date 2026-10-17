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
import { addDays, isoDate } from '../../domain/time.js';
import {
  ALL_RULES,
  defaultRuleSet,
  evaluateSchedule,
  hardRuleIdsByScope,
} from '../../rules/registry.js';
import type { RuleSet } from '../../rules/types.js';
import { busyElsewhere } from '../../schedule/elsewhere.js';
import { ScheduleView } from '../../schedule/view.js';
import {
  assign,
  assignRun,
  CRED_ACLS,
  census,
  coverage,
  coverageAllWeek,
  credentialRequirement,
  DAY_8,
  DAY_12,
  EVENING_8,
  MID_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  nurseCredential,
  ON_CALL,
  payRate,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  TIER_ROUTINE,
  timeOff,
  UNIT_ID,
} from '../../testing/fixtures.js';
import { SolverModel } from '../model.js';
import { Rng } from '../rng.js';
import { solve } from '../solver.js';
import type { SolveInput } from '../types.js';
import { CpBuilder, expr } from './builder.js';
import { OBJECTIVE_SCALE } from './context.js';
import { decodeCpsat, EncodingDisagreementError } from './decode.js';
import { CPSAT_ENCODERS, type CpsatEncoding, decisionsFor, encodeCpsat } from './encode.js';
import { lockedHardViolations } from './index.js';

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
    // Leave belongs to the shifts dated in it: the night before, finishing on its first
    // morning, is still the 5th's to work.
    expect(hasVariable(encoding, 'ada', '2026-01-05', NIGHT_12.id)).toBe(true);
    expect(hasVariable(encoding, 'ada', '2026-01-05', DAY_12.id)).toBe(true);
  });

  it('keeps the night before leave off limits where a day off is a whole calendar day', () => {
    const encoding = encodeCpsat(
      unit([ada()], {
        timeOff: [timeOff('ada', '2026-01-06', '2026-01-08')],
        ruleSet: withParams('approved-time-off-is-absolute', {
          nightShiftEndingOnLeaveCounts: true,
        }),
      }),
    );
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

  it('charges the k-th missing nurse k times the weight', () => {
    const b = new CpBuilder();
    const [x, y, z] = ['x', 'y', 'z'].map((name) => b.decision(name)) as [number, number, number];
    b.minimiseTriangular(
      expr([
        [x, 1],
        [y, 1],
        [z, 1],
      ]),
      10,
      't',
    );
    // 10 for the first, 20 for the second, 30 for the third: 0, 10, 30, 60.
    const expected = [0, 10, 30, 60];
    for (let k = 0; k <= 3; k++) {
      const decisions = new Map([x, y, z].slice(0, k).map((v) => [v, 1] as const));
      const evaluation = b.evaluate(decisions, OBJECTIVE_SCALE);
      expect(evaluation.violated).toEqual([]);
      expect(evaluation.objective).toBeCloseTo(expected[k]!, 6);
    }
  });

  it('builds nothing for a shortage the unit has chosen not to price', () => {
    const b = new CpBuilder();
    const x = b.decision('x');
    b.minimiseTriangular(expr([[x, 1]]), 0, 't');
    expect(b.variableCount).toBe(1);
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

  it('gives the after-night rest only after a night tour', () => {
    // A Title 38 evening tour (15:30–23:30) is paid as a night but is not one: 23:30 Mon to
    // 15:30 Tue is 16 hours, over the base 10, and the after-night 24 does not apply.
    const eveningTour = { ...EVENING_8, id: 'st-e8-va', startTime: '15:30', isNight: true };
    const encoding = encodeCpsat(
      unit([ada()], {
        shiftTypes: [DAY_12, NIGHT_12, eveningTour],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
          ...coverageAllWeek(eveningTour, 'RN', 1),
        ],
        ruleSet: withParams('min-rest-between-shifts', { minRestHoursAfterNight: 24 }),
      }),
    );
    const evenings = [
      assign('ada', eveningTour, '2026-01-05'),
      assign('ada', eveningTour, '2026-01-06'),
    ];
    expect(evaluate(encoding, evenings).violated).toEqual([]);
  });

  it('forbids a shift the rest rule would flag against the published lookback tail', () => {
    const lastNight = assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' });
    const encoding = encodeCpsat(unit([ada()], { priorAssignments: [lastNight] }));
    const morning = [assign('ada', DAY_12, '2026-01-04')];
    expect(evaluate(encoding, morning).violated.join('\n')).toMatch(/rest/);
  });
});

describe('tour rotation made hard', () => {
  /** The rule on and hard, with its parameters at the contract defaults unless overridden. */
  function hardTours(params: Record<string, unknown> = {}): RuleSet {
    const base = withParams('tour-rotation', params);
    return {
      ...base,
      configs: base.configs.map((c) =>
        c.ruleId === 'tour-rotation'
          ? { ...c, enabled: true, severityOverride: 'hard' as const }
          : c,
      ),
    };
  }

  it('forbids a day shift for a nurse on permanent nights', () => {
    const nurse = makeNurse({ id: 'ada', firstName: 'Ada', permanentTour: 'night' });
    const encoding = encodeCpsat(unit([nurse], { ruleSet: hardTours() }));
    expect(evaluate(encoding, [assign('ada', DAY_12, '2026-01-12')]).violated.join('\n')).toMatch(
      /permanent tour/,
    );
    expect(evaluate(encoding, [assign('ada', NIGHT_12, '2026-01-12')]).violated).toEqual([]);
  });

  it('lets a nurse on permanent nights be rotated when the contract does not enforce it', () => {
    const nurse = makeNurse({ id: 'ada', firstName: 'Ada', permanentTour: 'night' });
    const encoding = encodeCpsat(
      unit([nurse], { ruleSet: hardTours({ permanentTourEnforced: false }) }),
    );
    expect(evaluate(encoding, [assign('ada', DAY_12, '2026-01-12')]).violated).toEqual([]);
  });

  it('forbids nights to days with only 24 hours between, and allows it after 48', () => {
    const encoding = encodeCpsat(unit([ada()], { ruleSet: hardTours() }));
    // Night 19:00 Mon 5 Jan ends 07:00 Tue; Day 07:00 Wed is 24h on, Day 07:00 Thu is 48h.
    const quick = [assign('ada', NIGHT_12, '2026-01-05'), assign('ada', DAY_12, '2026-01-07')];
    expect(evaluate(encoding, quick).violated.join('\n')).toMatch(/tour change/);
    const slow = [assign('ada', NIGHT_12, '2026-01-05'), assign('ada', DAY_12, '2026-01-08')];
    expect(evaluate(encoding, slow).violated).toEqual([]);
  });

  it('forbids a day shift too soon after last schedule’s final night', () => {
    const lastNight = assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' });
    const encoding = encodeCpsat(
      unit([ada()], { priorAssignments: [lastNight], ruleSet: hardTours() }),
    );
    expect(evaluate(encoding, [assign('ada', DAY_12, '2026-01-05')]).violated.join('\n')).toMatch(
      /tour change/,
    );
    expect(evaluate(encoding, [assign('ada', DAY_12, '2026-01-06')]).violated).toEqual([]);
  });

  it('forbids a third tour in one schedule, allows two', () => {
    const encoding = encodeCpsat(
      unit([ada()], {
        shiftTypes: [DAY_12, EVENING_8, NIGHT_12],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(EVENING_8, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ],
        ruleSet: hardTours(),
      }),
    );
    const two = [assign('ada', DAY_12, '2026-01-05'), assign('ada', EVENING_8, '2026-01-09')];
    expect(evaluate(encoding, two).violated).toEqual([]);
    const three = [...two, assign('ada', NIGHT_12, '2026-01-14')];
    expect(evaluate(encoding, three).violated.join('\n')).toMatch(/tours per schedule/);
  });

  it('lets three locked tours stand at a maximum of two without making the model infeasible', () => {
    const locked = [
      assign('ada', DAY_12, '2026-01-05', { isLocked: true }),
      assign('ada', EVENING_8, '2026-01-09', { isLocked: true }),
      assign('ada', NIGHT_12, '2026-01-14', { isLocked: true }),
    ];
    const encoding = encodeCpsat(
      unit([ada()], {
        shiftTypes: [DAY_12, EVENING_8, NIGHT_12],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(EVENING_8, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ],
        assignments: locked,
        ruleSet: hardTours(),
      }),
    );
    expect(evaluate(encoding, locked).violated).toEqual([]);
  });

  it('counts a locked shift toward the tours already worked', () => {
    const locked = assign('ada', DAY_12, '2026-01-05', { isLocked: true });
    const encoding = encodeCpsat(
      unit([ada()], {
        shiftTypes: [DAY_12, EVENING_8, NIGHT_12],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(EVENING_8, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ],
        assignments: [locked],
        ruleSet: hardTours({ maxToursPerPeriod: 2 }),
      }),
    );
    const evening = assign('ada', EVENING_8, '2026-01-09');
    const night = assign('ada', NIGHT_12, '2026-01-14');
    expect(evaluate(encoding, [locked, evening, night]).violated.join('\n')).toMatch(
      /tours per schedule/,
    );
    expect(evaluate(encoding, [locked, evening]).violated).toEqual([]);
  });

  it('lets a career nurse work the night she asked for when tour rotation is hard', () => {
    // Hired 1 Jan 2010: sixteen years at Sun 4 Jan 2026, exempt at ten, so held to one tour.
    // Day 07:00–19:00 Mon 5 Jan, night 19:00 Thu 8 Jan: 72 hours apart, so only the tour count
    // can object, and nights are hers by asking.
    const career = makeNurse({ id: 'ada', firstName: 'Ada', hireDate: isoDate('2010-01-01') });
    const wantsNights: Preference = {
      id: 'pref-ada-nights',
      nurseId: 'ada',
      kind: 'prefer_shift_type',
      shiftTypeId: NIGHT_12.id,
      weight: 1,
    };
    const judge = (preferences: Preference[]) => {
      const encoding = encodeCpsat(
        unit([career], {
          preferences,
          ruleSet: hardTours({ maxToursPerPeriod: 2, exemptAfterYearsOfService: 10 }),
        }),
      );
      const model = encoding.solverModel;
      model.add(model.make(0, model.shiftAt(1, DAY_12)));
      const sa = model.canAdd(0, model.make(0, model.shiftAt(4, NIGHT_12)));
      const cpsat = evaluate(encoding, [
        assign('ada', DAY_12, '2026-01-05'),
        assign('ada', NIGHT_12, '2026-01-08'),
      ]).violated;
      return { sa, cpsat };
    };
    const asked = judge([wantsNights]);
    expect(asked.sa).toBe(true);
    expect(asked.cpsat).toEqual([]);
    const forced = judge([]);
    expect(forced.sa).toBe(false);
    expect(forced.cpsat.join('\n')).toMatch(/tours per schedule: Ada/);
  });

  it('lets a career nurse on permanent days work the night she asked for when tour rotation is hard', () => {
    // Hired 1 Jan 2010: sixteen years at Sun 4 Jan 2026, exempt at ten, so kept on her permanent
    // day tour. A lone night on Thu 8 Jan: only the permanent tour can object, and nights are
    // hers by asking.
    const career = makeNurse({
      id: 'ada',
      firstName: 'Ada',
      hireDate: isoDate('2010-01-01'),
      permanentTour: 'day',
    });
    const wantsNights: Preference = {
      id: 'pref-ada-nights',
      nurseId: 'ada',
      kind: 'prefer_shift_type',
      shiftTypeId: NIGHT_12.id,
      weight: 1,
    };
    const judge = (preferences: Preference[]) => {
      const encoding = encodeCpsat(
        unit([career], {
          preferences,
          ruleSet: hardTours({ exemptAfterYearsOfService: 10 }),
        }),
      );
      const model = encoding.solverModel;
      const sa = model.canAdd(0, model.make(0, model.shiftAt(4, NIGHT_12)));
      const cpsat = evaluate(encoding, [assign('ada', NIGHT_12, '2026-01-08')]).violated;
      return { sa, cpsat };
    };
    const asked = judge([wantsNights]);
    expect(asked.sa).toBe(true);
    expect(asked.cpsat).toEqual([]);
    const forced = judge([]);
    expect(forced.sa).toBe(false);
    expect(forced.cpsat.join('\n')).toMatch(/permanent tour: Ada/);
  });
});

describe('tours on a nurse’s plan', () => {
  /** Ada is on the 72/80 plan, Bo on the Baylor weekend plan; Day 8 is never a tour of either. */
  const planUnit = (options: Partial<SolveScenarioOptions> = {}) =>
    unit(
      [
        makeNurse({
          id: 'ada',
          firstName: 'Ada',
          isChargeEligible: true,
          scheduleKind: 'va_72_80',
        }),
        makeNurse({ id: 'bo', firstName: 'Bo', scheduleKind: 'va_baylor' }),
      ],
      {
        shiftTypes: [DAY_12, NIGHT_12, DAY_8],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
          ...coverageAllWeek(DAY_8, 'RN', 1),
        ],
        ...options,
      },
    );
  const offPlan = (encoding: CpsatEncoding, assignments: Assignment[]) =>
    evaluate(encoding, assignments).violated.filter((v) => v.startsWith('off plan'));

  it('forbids an 8-hour day for the 72/80 nurse and allows her 12s on any day', () => {
    const encoding = encodeCpsat(planUnit());
    expect(offPlan(encoding, [assign('ada', DAY_8, '2026-01-07')])).toEqual([
      'off plan: Ada Test D8 2026-01-07',
    ]);
    expect(
      offPlan(encoding, [
        assign('ada', DAY_12, '2026-01-07'),
        assign('ada', NIGHT_12, '2026-01-09'),
      ]),
    ).toEqual([]);
  });

  it('forbids a Wednesday 12 for the Baylor nurse, and allows Friday night and Sunday', () => {
    const encoding = encodeCpsat(planUnit());
    expect(offPlan(encoding, [assign('bo', DAY_12, '2026-01-07')])).toEqual([
      'off plan: Bo Test D12 2026-01-07',
    ]);
    // Friday's day 12 ends at 19:00, before the weekend begins.
    expect(offPlan(encoding, [assign('bo', DAY_12, '2026-01-09')])).toEqual([
      'off plan: Bo Test D12 2026-01-09',
    ]);
    expect(
      offPlan(encoding, [assign('bo', NIGHT_12, '2026-01-09'), assign('bo', DAY_12, '2026-01-11')]),
    ).toEqual([]);
    expect(offPlan(encoding, [assign('bo', DAY_12, '2026-01-10')])).toEqual([]);
  });

  it('lets a locked off-plan shift stand without making the model infeasible', () => {
    const locked = assign('ada', DAY_8, '2026-01-07', { isLocked: true });
    const encoding = encodeCpsat(planUnit({ assignments: [locked] }));
    expect(evaluate(encoding, [locked]).violated).toEqual([]);
  });
});

describe('a Baylor nurse and the weekend pattern', () => {
  // Bo works the weekends of 27 Dec (last schedule), 3 Jan (Sun 4), 10 and 17 Jan: four in four,
  // and four in a row. Under every-other-weekend and two-in-four that is a breach for anyone else;
  // the Baylor plan is weekends by contract.
  const bo = () =>
    makeNurse({ id: 'bo', firstName: 'Bo', isChargeEligible: true, scheduleKind: 'va_baylor' });
  const weekends = ['2026-01-04', '2026-01-10', '2026-01-17'].map((d) => assign('bo', DAY_12, d));
  const prior = [assign('bo', DAY_12, '2025-12-27', { periodId: 'prev' })];
  function weekendRules(severity: 'hard' | 'soft'): RuleSet {
    const base = withParams('weekend-pattern', {
      maxConsecutiveWeekends: 1,
      maxWeekendsPer4Weeks: 2,
    });
    return {
      ...base,
      configs: base.configs.map((c) =>
        c.ruleId === 'weekend-pattern' ? { ...c, enabled: true, severityOverride: severity } : c,
      ),
    };
  }

  it('does not forbid a Baylor nurse every weekend when the pattern is hard', () => {
    const encoding = encodeCpsat(
      unit([bo()], { priorAssignments: prior, ruleSet: weekendRules('hard') }),
    );
    expect(evaluate(encoding, weekends).violated.filter((v) => v.startsWith('weekends'))).toEqual(
      [],
    );
  });

  it('prices no weekend breach for a Baylor nurse in either solver', () => {
    const input = unit([bo()], { priorAssignments: prior, ruleSet: weekendRules('soft') });
    const model = new SolverModel(input);
    for (const a of weekends) model.add(a);
    expect(model.weekendBreaches()).toBe(0);
    const plain = unit([{ ...bo(), scheduleKind: undefined }], {
      priorAssignments: prior,
      ruleSet: weekendRules('soft'),
    });
    // The same roster on a standard nurse costs weekend breaches in both; on Bo, in neither.
    const standard = new SolverModel(plain);
    for (const a of weekends) standard.add(a);
    expect(standard.weekendBreaches()).toBeGreaterThan(0);
    const baylorCost = evaluate(encodeCpsat(input), weekends).objective;
    const standardCost = evaluate(encodeCpsat(plain), weekends).objective;
    expect(baylorCost).toBeCloseTo(model.breakdown().total, 0);
    expect(standardCost - baylorCost).toBeCloseTo(
      standard.breakdown().total - model.breakdown().total,
      0,
    );
    expect(standardCost).toBeGreaterThan(baylorCost);
  });
});

describe('a Baylor nurse and the holiday rotation', () => {
  // Bo worked last year's Mid Day, so a rotating nurse is owed this year's off; Mid Eve (Fri 9)
  // pairs with Mid Day (Sat 10). Bo works the night 12s of both: two Baylor tours, 12h apart.
  const h = (id: string, date: string, name: string, isMajor: boolean, paired: string | null) => ({
    id,
    unitId: UNIT_ID,
    date: isoDate(date),
    name,
    isMajor,
    pairedHolidayId: paired,
  });
  const holidays = [
    h('mid-25', '2025-01-10', 'Mid Day', true, null),
    h('mid-eve', '2026-01-09', 'Mid Eve', false, 'mid-26'),
    h('mid-26', '2026-01-10', 'Mid Day', true, null),
  ];
  const roster = [assign('bo', NIGHT_12, '2026-01-09'), assign('bo', NIGHT_12, '2026-01-10')];
  function input(severity: 'hard' | 'soft', scheduleKind?: 'va_baylor'): SolveInput {
    const base = withParams('holiday-rotation', { pairMinorWithMajor: true });
    const bo = makeNurse({ id: 'bo', firstName: 'Bo', isChargeEligible: true, scheduleKind });
    return unit([bo], {
      holidays,
      holidayWork: [{ holidayId: 'mid-25', nurseId: 'bo' }],
      ruleSet: {
        ...base,
        configs: base.configs.map((c) =>
          c.ruleId === 'holiday-rotation' ? { ...c, severityOverride: severity } : c,
        ),
      },
    });
  }
  const holidayLabels = (encoding: CpsatEncoding) =>
    evaluate(encoding, roster).violated.filter((v) => v.startsWith('holiday'));

  it('forbids neither the owed day nor the pair when the rotation is hard', () => {
    expect(holidayLabels(encodeCpsat(input('hard')))).not.toEqual([]);
    expect(holidayLabels(encodeCpsat(input('hard', 'va_baylor')))).toEqual([]);
  });

  it('prices no rotation breach in either solver', () => {
    const price = (i: SolveInput) => {
      const model = new SolverModel(i);
      for (const a of roster) model.add(a);
      const cpsat = evaluate(encodeCpsat(i), roster).objective;
      expect(cpsat).toBeCloseTo(model.breakdown().total, 0);
      return model.holidayBreaches();
    };
    // Standard: the owed Mid Day worked, and both halves of the pair.
    expect(price(input('soft'))).toBe(2);
    expect(price(input('soft', 'va_baylor'))).toBe(0);
  });
});

/** `days-off-together` on and hard. */
function hardDaysOff(base: RuleSet = defaultRuleSet(UNIT_ID)): RuleSet {
  return {
    ...base,
    configs: base.configs.map((c) =>
      c.ruleId === 'days-off-together'
        ? { ...c, enabled: true, severityOverride: 'hard' as const }
        : c,
    ),
  };
}

describe('two days off together made hard', () => {
  // Every weekend of the pay period Sun 4 – Sat 17 Jan: Sun 4 (Sat 3's weekend), Sat 10, Sun 11,
  // Sat 17, with the weekly caps out of the way and a contract that holds ten 12s (120h) so this
  // rule is what bites.
  const weekends = ['2026-01-04', '2026-01-10', '2026-01-11', '2026-01-17'];
  const daysOn = (dates: string[]) => dates.map((d) => assign('ada', DAY_12, d));
  const fullTime = () => makeNurse({ id: 'ada', firstName: 'Ada', contractedHoursPerPeriod: 120 });

  it('forbids every weekend worked with the days off scattered, allows a pair off', () => {
    const encoding = encodeCpsat(unit([fullTime()], { ruleSet: hardDaysOff(NO_WEEKLY_CAP) }));
    // Off 6, 8, 12, 14, 16: none adjacent.
    const scattered = daysOn([
      ...weekends,
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-15',
    ]);
    expect(evaluate(encoding, scattered).violated.join('\n')).toMatch(/days off together/);
    // Off 8, 12, 15, 16: Thu 15 and Fri 16 together.
    const paired = daysOn([
      ...weekends,
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-14',
    ]);
    expect(evaluate(encoding, paired).violated).toEqual([]);
    // The middle weekend off: nothing owed, whatever the weekdays.
    const skipped = daysOn([
      '2026-01-04',
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-15',
      '2026-01-17',
    ]);
    expect(evaluate(encoding, skipped).violated).toEqual([]);
  });

  it('still asks for the pair when every weekend shift is locked', () => {
    const locked = weekends.map((d) => assign('ada', DAY_12, d, { isLocked: true }));
    const encoding = encodeCpsat(
      unit([fullTime()], { assignments: locked, ruleSet: hardDaysOff(NO_WEEKLY_CAP) }),
    );
    const scattered = daysOn([
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-13',
      '2026-01-15',
    ]);
    expect(evaluate(encoding, [...locked, ...scattered]).violated.join('\n')).toMatch(
      /days off together/,
    );
    expect(evaluate(encoding, locked).violated).toEqual([]);
  });

  it('does not credit last pay period’s Saturday to the first weekend', () => {
    // Sat 3 Jan lies in the previous pay period and Sun 4 is off, so no shift dated 4–17 Jan is
    // filed under the weekend of the 3rd: not every weekend is worked, and the scattered days off
    // (4, 6, 8, 12, 14, 16) are owed nothing.
    const prior = [assign('ada', DAY_12, '2026-01-03', { periodId: 'prev' })];
    const encoding = encodeCpsat(
      unit([fullTime()], { priorAssignments: prior, ruleSet: hardDaysOff(NO_WEEKLY_CAP) }),
    );
    const shifts = daysOn([
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
      '2026-01-10',
      '2026-01-11',
      '2026-01-13',
      '2026-01-15',
      '2026-01-17',
    ]);
    expect(evaluate(encoding, shifts).violated.join('\n')).not.toMatch(/days off together/);
    // Control: work Sun 4 as well. It is dated in the pay period and filed under Sat 3, so every
    // weekend (3, 10, 17) is worked, and the days off 6, 8, 12, 14, 16 hold no pair: a breach of
    // the pay period opening Sun 4, under its own label.
    const withSunday = [...shifts, ...daysOn(['2026-01-04'])];
    expect(evaluate(encoding, withSunday).violated).toContain(
      'days off together: Ada Test 2026-01-04',
    );
  });
});

/** The rule on and hard at the given cap, with min-rest out of the way so the cap is what bites. */
function hardHoursIn24(maxHours: number): RuleSet {
  const base = withParams(
    'max-hours-in-24',
    { maxHours },
    withParams('min-rest-between-shifts', { minRestHours: 0 }),
  );
  return {
    ...base,
    configs: base.configs.map((c) =>
      c.ruleId === 'max-hours-in-24'
        ? { ...c, enabled: true, severityOverride: 'hard' as const }
        : c,
    ),
  };
}

describe('most hours in any 24 made hard', () => {
  it('forbids a night 12 straight into the next day 12: 24 hours worked, cap 16', () => {
    const encoding = encodeCpsat(unit([ada()], { ruleSet: hardHoursIn24(16) }));
    const double = [assign('ada', NIGHT_12, '2026-01-12'), assign('ada', DAY_12, '2026-01-13')];
    expect(evaluate(encoding, double).violated.join('\n')).toMatch(/hours in 24/);
  });

  it('allows a night 12 straight into the next day 12 when the cap is 24', () => {
    const encoding = encodeCpsat(unit([ada()], { ruleSet: hardHoursIn24(24) }));
    const double = [assign('ada', NIGHT_12, '2026-01-12'), assign('ada', DAY_12, '2026-01-13')];
    expect(evaluate(encoding, double).violated).toEqual([]);
  });

  it('allows a day 12 on Monday and another on Tuesday: 12 hours in any 24', () => {
    const encoding = encodeCpsat(unit([ada()], { ruleSet: hardHoursIn24(16) }));
    const days = [assign('ada', DAY_12, '2026-01-12'), assign('ada', DAY_12, '2026-01-13')];
    expect(evaluate(encoding, days).violated).toEqual([]);
  });

  it('counts a night 12 in the lookback tail against the first day shift of the schedule', () => {
    const lastNight = assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' });
    const encoding = encodeCpsat(
      unit([ada()], { priorAssignments: [lastNight], ruleSet: hardHoursIn24(16) }),
    );
    expect(evaluate(encoding, [assign('ada', DAY_12, '2026-01-04')]).violated.join('\n')).toMatch(
      /hours in 24/,
    );
  });

  it('counts a holdover on the lookback shift: the day 12 after it is forbidden, and allowed without it', () => {
    // Sat 3 Jan day 12 held over 5h ends at midnight. A day 12 from 07:00 Sun makes 5h + 12h = 17h
    // from 19:00 Sat; without the holdover the same window holds 12h.
    const sunday = assign('ada', DAY_12, '2026-01-04');
    const judge = (holdoverMinutes: number | undefined) => {
      const prior = assign('ada', DAY_12, '2026-01-03', {
        periodId: 'prev',
        ...(holdoverMinutes === undefined ? {} : { holdoverMinutes }),
      });
      const input = unit([ada()], { priorAssignments: [prior], ruleSet: hardHoursIn24(16) });
      const encoding = encodeCpsat(input);
      const model = encoding.solverModel;
      const view = new ScheduleView({
        period: input.period,
        assignments: [sunday],
        priorAssignments: input.priorAssignments,
        nurses: model.nurses,
        shiftTypes: model.shiftTypes,
      });
      const rules = evaluateSchedule(view, input.ruleSet, model.ctx, {
        only: ['max-hours-in-24'],
      }).hardViolations;
      return { encoded: evaluate(encoding, [sunday]).violated, rules };
    };
    const held = judge(300);
    expect(held.encoded.join('\n')).toMatch(/hours in 24/);
    expect(held.rules).toHaveLength(1);
    const plain = judge(undefined);
    expect(plain.encoded).toEqual([]);
    expect(plain.rules).toEqual([]);
  });

  it('lets a locked double stand without making the model infeasible', () => {
    const locked = [
      assign('ada', NIGHT_12, '2026-01-12', { isLocked: true }),
      assign('ada', DAY_12, '2026-01-13', { isLocked: true }),
    ];
    const encoding = encodeCpsat(
      unit([ada()], { assignments: locked, ruleSet: hardHoursIn24(16) }),
    );
    expect(evaluate(encoding, locked).violated).toEqual([]);
  });

  it('keeps a free day 12 off the end of a locked night 12 under a 16-hour cap', () => {
    const locked = assign('ada', NIGHT_12, '2026-01-12', { isLocked: true });
    const encoding = encodeCpsat(
      unit([ada()], { assignments: [locked], ruleSet: hardHoursIn24(16) }),
    );
    expect(
      evaluate(encoding, [locked, assign('ada', DAY_12, '2026-01-13')]).violated.join('\n'),
    ).toMatch(/hours in 24/);
  });
});

/** 07:30–12:30: half an hour after a night 12 ends, so a bridge of an hour joins them. */
const MORNING_5 = {
  ...DAY_8,
  id: 'st-m5',
  name: 'Morning 5',
  abbreviation: 'M5',
  startTime: '07:30',
  durationHours: 5,
};
/** 15:30–23:30: half an hour after a day 8 ends. */
const LATE_8 = { ...DAY_8, id: 'st-l8', name: 'Late 8', abbreviation: 'L8', startTime: '15:30' };
/** 07:30–15:30: half an hour after a night 12 ends, the next day (one shift a day). */
const LATE_DAY_8 = {
  ...DAY_8,
  id: 'st-ld8',
  name: 'Late day 8',
  abbreviation: 'LD8',
  startTime: '07:30',
};

/** 08:00 and 08:01 starts: 60 and 61 minutes after a night 12 ends, either side of a 60 bridge. */
const AT_0800 = {
  ...DAY_8,
  id: 'st-a0800',
  name: 'Day 8 at 08:00',
  abbreviation: 'D8a',
  startTime: '08:00',
};
const AT_0801 = {
  ...DAY_8,
  id: 'st-a0801',
  name: 'Day 8 at 08:01',
  abbreviation: 'D8b',
  startTime: '08:01',
};

/** The rule on and hard with the given limits, min-rest out of the way so this rule is what bites. */
function hardLongStretch(params: Record<string, unknown>): RuleSet {
  const base = withParams(
    'long-stretch',
    params,
    withParams('min-rest-between-shifts', { minRestHours: 0 }),
  );
  return {
    ...base,
    configs: base.configs.map((c) =>
      c.ruleId === 'long-stretch' ? { ...c, enabled: true, severityOverride: 'hard' as const } : c,
    ),
  };
}

describe('long stretches of work made hard', () => {
  const stretchUnit = (
    params: Record<string, unknown>,
    options: Partial<SolveScenarioOptions> = {},
  ) => unit([ada()], { ruleSet: hardLongStretch(params), ...options });
  // Night 12 19:00 Mon to 07:00, then day 12 to 19:00 Tue: 24 hours straight. (A second shift
  // the same day is out of reach: one shift a day is structural.)
  const double = () => [assign('ada', NIGHT_12, '2026-01-12'), assign('ada', DAY_12, '2026-01-13')];

  it('forbids a night 12 straight into the next day 12 under a 14-hour cap', () => {
    const encoding = encodeCpsat(stretchUnit({ maxConsecutiveHours: 14 }));
    expect(evaluate(encoding, double()).violated.join('\n')).toMatch(/long stretch/);
  });

  it('allows the same double under a 24-hour cap, and a lone shift under 14', () => {
    const encoding = encodeCpsat(stretchUnit({ maxConsecutiveHours: 24 }));
    expect(evaluate(encoding, double()).violated).toEqual([]);
    const lone = encodeCpsat(stretchUnit({ maxConsecutiveHours: 14 }));
    expect(evaluate(lone, [assign('ada', DAY_12, '2026-01-13')]).violated).toEqual([]);
  });

  it('writes nothing when only required hours count: a draft holds none', () => {
    const encoding = encodeCpsat(stretchUnit({ maxConsecutiveHours: 14, requiredOnly: true }));
    expect(evaluate(encoding, double()).violated).toEqual([]);
  });

  it('wants 14 hours off after a 24-hour stretch: a day 12 at 07:00 the next morning is 12 hours', () => {
    // Out at 19:00 Tuesday, back at 07:00 Wednesday.
    const encoding = encodeCpsat(stretchUnit({ restAfterHours: 24, restHours: 14 }));
    const tooSoon = [...double(), assign('ada', DAY_12, '2026-01-14')];
    expect(evaluate(encoding, tooSoon).violated.join('\n')).toMatch(/rest after long stretch/);
    expect(evaluate(encoding, double()).violated).toEqual([]);
    const enough = encodeCpsat(stretchUnit({ restAfterHours: 24, restHours: 12 }));
    expect(evaluate(enough, tooSoon).violated).toEqual([]);
  });

  it('owes no rest after a stretch of exactly the threshold when it must be passed, and owes it otherwise', () => {
    // Day 12 07:00-19:00 Tuesday is 12 hours; day 12 again at 07:00 Wednesday is 12h off, short of 14.
    const days = [assign('ada', DAY_12, '2026-01-13'), assign('ada', DAY_12, '2026-01-14')];
    const params = { restAfterHours: 12, restHours: 14 };
    const past = encodeCpsat(stretchUnit({ ...params, restOnlyPastThreshold: true }));
    expect(evaluate(past, days).violated).toEqual([]);
    const reaching = encodeCpsat(stretchUnit({ ...params, restOnlyPastThreshold: false }));
    expect(evaluate(reaching, days).violated.join('\n')).toMatch(/rest after long stretch/);
  });

  it('lets a waiver on the later shift excuse the rest', () => {
    const waiver = {
      id: 'w-1',
      unitId: UNIT_ID,
      nurseId: 'ada',
      date: isoDate('2026-01-14'),
      reason: 'Signed waiver',
      createdAt: 0,
    };
    const params = { restAfterHours: 24, restHours: 14, honorsRestWaiver: true };
    const tooSoon = [...double(), assign('ada', DAY_12, '2026-01-14')];
    const waived = encodeCpsat(stretchUnit(params, { restWaivers: [waiver] }));
    expect(evaluate(waived, tooSoon).violated).toEqual([]);
    const unwaived = encodeCpsat(stretchUnit(params));
    expect(evaluate(unwaived, tooSoon).violated.join('\n')).toMatch(/rest after long stretch/);
  });

  it('lets a locked stretch over the cap stand without making the model infeasible', () => {
    const locked = double().map((a) => ({ ...a, isLocked: true }));
    const encoding = encodeCpsat(stretchUnit({ maxConsecutiveHours: 14 }, { assignments: locked }));
    expect(evaluate(encoding, locked).violated).toEqual([]);
  });

  it('forbids 17 hours around a half-hour break under a 16-hour cap that bridges an hour', () => {
    // One shift a day is structural, so the break sits across midnight's morning: night 12
    // 19:00 Mon to 07:00 Tue, a break to 07:30, then 07:30–12:30. 12 + 5 = 17 worked, past 16.
    const withMorning = {
      shiftTypes: [DAY_12, NIGHT_12, MORNING_5],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ...coverageAllWeek(MORNING_5, 'RN', 1),
      ],
    };
    const pair = [assign('ada', NIGHT_12, '2026-01-12'), assign('ada', MORNING_5, '2026-01-13')];
    const bridged = encodeCpsat(
      stretchUnit({ maxConsecutiveHours: 16, maxBreakMinutesInStretch: 60 }, withMorning),
    );
    expect(evaluate(bridged, pair).violated.join('\n')).toMatch(/long stretch/);
    // Without the bridge the half hour ends the stretch: 12 and 5, each under 16.
    const unbridged = encodeCpsat(stretchUnit({ maxConsecutiveHours: 16 }, withMorning));
    expect(evaluate(unbridged, pair).violated).toEqual([]);
  });

  it('joins a shift starting exactly the bridge after a night, and not one a minute later', () => {
    // Night 12 19:00 Mon to 07:00 Tue. A day 8 at 08:00 Tue is 60 minutes on, within a 60-minute
    // bridge: one stretch of 12 + 8 = 20 worked, past 14. At 08:01 it is 61 minutes on, so the
    // stretches are 12 and 8, each within 14.
    const options = {
      shiftTypes: [DAY_12, NIGHT_12, AT_0800, AT_0801],
      coverageRequirements: [DAY_12, NIGHT_12, AT_0800, AT_0801].flatMap((t) =>
        coverageAllWeek(t, 'RN', 1),
      ),
    };
    const encoding = encodeCpsat(
      stretchUnit({ maxConsecutiveHours: 14, maxBreakMinutesInStretch: 60 }, options),
    );
    const night = assign('ada', NIGHT_12, '2026-01-12');
    expect(
      evaluate(encoding, [night, assign('ada', AT_0800, '2026-01-13')]).violated.join('\n'),
    ).toMatch(/long stretch/);
    expect(evaluate(encoding, [night, assign('ada', AT_0801, '2026-01-13')]).violated).toEqual([]);
  });

  it('lets a locked emergency shift a half-hour break earlier excuse the cap, as the rule does', () => {
    // A locked night 12 noted "Emergency:" runs 19:00 Mon to 07:00 Tue; a late day 8 starts at
    // 07:30 Tue. With a 60-minute bridge they are one stretch of 12 + 8 = 20 worked, which the
    // emergency excuses. The late day alone (8 hours, past a 7-hour cap) is the chain the encoder
    // forbids, and the emergency ends 30 minutes before it starts, so it must still be seen.
    const emergency = assign('ada', NIGHT_12, '2026-01-12', {
      isLocked: true,
      notes: 'Emergency: no relief available',
    });
    const input = stretchUnit(
      { maxConsecutiveHours: 7, maxBreakMinutesInStretch: 60, emergencyLiftsCap: true },
      {
        shiftTypes: [DAY_12, NIGHT_12, LATE_DAY_8],
        coverageRequirements: [DAY_12, NIGHT_12, LATE_DAY_8].flatMap((t) =>
          coverageAllWeek(t, 'RN', 1),
        ),
        assignments: [emergency],
      },
    );
    const encoding = encodeCpsat(input);
    const schedule = [emergency, assign('ada', LATE_DAY_8, '2026-01-13')];
    const model = encoding.solverModel;
    const view = new ScheduleView({
      period: input.period,
      assignments: schedule,
      priorAssignments: input.priorAssignments,
      nurses: model.nurses,
      shiftTypes: model.shiftTypes,
    });
    const ruleViolations = evaluateSchedule(view, input.ruleSet, model.ctx, {
      only: hardRuleIdsByScope(input.ruleSet, 'nurse'),
    }).hardViolations.filter((v) => v.code !== 'under_contracted_hours');
    expect(ruleViolations.map((v) => v.message)).toEqual([]);
    expect(evaluate(encoding, schedule).violated).toEqual([]);
  });
});

describe('a rest waiver', () => {
  // Night 19:00 Mon 5 Jan to 07:00 Tue, then Day 07:00 Tue 6 Jan: no rest at all.
  const turnaround = [assign('ada', NIGHT_12, '2026-01-05'), assign('ada', DAY_12, '2026-01-06')];
  const waiver = (date: string) => ({
    id: `w-${date}`,
    unitId: UNIT_ID,
    nurseId: 'ada',
    date: isoDate(date),
    reason: 'Signed waiver',
    createdAt: 0,
  });

  it('forbids the night-to-day turnaround when no waiver is on file', () => {
    const encoding = encodeCpsat(unit([ada()]));
    expect(evaluate(encoding, turnaround).violated.join('\n')).toMatch(/rest/);
  });

  it('lets the turnaround stand for the shift that starts on the waived date', () => {
    const encoding = encodeCpsat(unit([ada()], { restWaivers: [waiver('2026-01-06')] }));
    expect(evaluate(encoding, turnaround).violated).toEqual([]);
  });

  it('does not excuse a turnaround whose later shift is on another date', () => {
    const encoding = encodeCpsat(unit([ada()], { restWaivers: [waiver('2026-01-05')] }));
    expect(evaluate(encoding, turnaround).violated.join('\n')).toMatch(/rest/);
  });

  const afterNight36 = withParams('min-rest-between-shifts', { minRestHoursAfterNight: 36 });

  it('lets a waived turnaround stand without forbidding the rest after the night it follows', () => {
    const input = unit([ada()], { ruleSet: afterNight36, restWaivers: [waiver('2026-01-06')] });
    const encoding = encodeCpsat(input);
    const schedule = [
      assign('ada', NIGHT_12, '2026-01-05'), // 19:00 Mon → 07:00 Tue
      assign('ada', DAY_12, '2026-01-06'), // 07:00 → 19:00 Tue, waived turnaround
      assign('ada', DAY_12, '2026-01-07'), // 07:00 Wed: 12h after Tuesday's day, 10 required
    ];
    // The rules judge N→D Tue (waived) and D Tue→D Wed (12h ≥ 10). Night → Wed day is 24h < 36,
    // but Tuesday's worked day ends at 19:00 Tue, after the night's 07:00, and starts before
    // 07:00 Wed, so rest is measured from it, not from the night.
    expect(evaluate(encoding, schedule).violated).toEqual([]);
    // A fixed parity case: the random rosters never build this pattern, so the rule engine is
    // asked directly and must agree that the schedule is legal.
    const model = encoding.solverModel;
    const view = new ScheduleView({
      period: input.period,
      assignments: schedule,
      priorAssignments: input.priorAssignments,
      nurses: model.nurses,
      shiftTypes: model.shiftTypes,
    });
    const ruleViolations = evaluateSchedule(view, input.ruleSet, model.ctx, {
      only: hardRuleIdsByScope(input.ruleSet, 'nurse'),
    }).hardViolations.filter((v) => v.code !== 'under_contracted_hours');
    expect(ruleViolations.map((v) => v.message)).toEqual([]);
  });

  it('still forbids the rest after a night when the shift between is not worked', () => {
    const encoding = encodeCpsat(
      unit([ada()], { ruleSet: afterNight36, restWaivers: [waiver('2026-01-06')] }),
    );
    const schedule = [assign('ada', NIGHT_12, '2026-01-05'), assign('ada', DAY_12, '2026-01-07')];
    // 07:00 Tue → 07:00 Wed is 24h, short of the 36 owed after a night, and nothing is between.
    expect(evaluate(encoding, schedule).violated.join('\n')).toMatch(
      /rest: .*N12 2026-01-05 → D12 2026-01-07/,
    );
  });
});

describe('an accommodation', () => {
  // The Sabbath: Fridays 18:00 for 24 hours. 9 Jan 2026 is a Friday.
  const sabbath = {
    id: 'blk-sabbath',
    unitId: UNIT_ID,
    nurseId: 'ada',
    weekdays: [5 as const],
    startTime: '18:00',
    endTime: '18:00',
    reason: 'Religious accommodation',
  };

  const withStandby = (ruleSet?: RuleSet) =>
    unit([ada()], {
      shiftTypes: [DAY_12, NIGHT_12, ON_CALL],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ...coverageAllWeek(ON_CALL, 'RN', 0, 1),
      ],
      availabilityBlocks: [sabbath],
      ...(ruleSet ? { ruleSet } : {}),
    });

  it('forbids standby inside the window by default', () => {
    const encoding = encodeCpsat(withStandby());
    expect(evaluate(encoding, [assign('ada', ON_CALL, '2026-01-09')]).violated.join('\n')).toMatch(
      /accommodation/,
    );
  });

  it('allows standby inside the window when the unit turns that off', () => {
    const encoding = encodeCpsat(
      withStandby(withParams('accommodation-blocks', { onCallCounts: false })),
    );
    expect(evaluate(encoding, [assign('ada', ON_CALL, '2026-01-09')]).violated).toEqual([]);
  });

  it('forbids the Friday night, which starts inside the window', () => {
    const encoding = encodeCpsat(unit([ada()], { availabilityBlocks: [sabbath] }));
    expect(evaluate(encoding, [assign('ada', NIGHT_12, '2026-01-09')]).violated.join('\n')).toMatch(
      /accommodation/,
    );
  });

  it('forbids the Friday day shift that runs to 19:00, past 18:00', () => {
    const encoding = encodeCpsat(unit([ada()], { availabilityBlocks: [sabbath] }));
    expect(evaluate(encoding, [assign('ada', DAY_12, '2026-01-09')]).violated.join('\n')).toMatch(
      /accommodation/,
    );
  });

  it('allows the Thursday night that ends at 07:00 on Friday', () => {
    const encoding = encodeCpsat(unit([ada()], { availabilityBlocks: [sabbath] }));
    expect(evaluate(encoding, [assign('ada', NIGHT_12, '2026-01-08')]).violated).toEqual([]);
  });

  it('allows the Saturday night that starts when the window has closed', () => {
    const encoding = encodeCpsat(unit([ada()], { availabilityBlocks: [sabbath] }));
    expect(evaluate(encoding, [assign('ada', NIGHT_12, '2026-01-10')]).violated).toEqual([]);
  });

  it('leaves another nurse’s Friday night alone', () => {
    const encoding = encodeCpsat(
      unit([ada(), makeNurse({ id: 'bo', firstName: 'Bo', lastName: 'Ruiz' })], {
        availabilityBlocks: [sabbath],
      }),
    );
    expect(evaluate(encoding, [assign('bo', NIGHT_12, '2026-01-09')]).violated).toEqual([]);
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

  it('forbids four nights after a day shift: the nights are counted wherever they sit', () => {
    // Day Mon then nights Tue–Fri: a five-day stretch, within the limit of five, but the night
    // window Tue–Fri holds 4 > 3. The day before the nights does not hide them.
    const encoding = encodeCpsat(unit([ada()], { ruleSet: NO_WEEKLY_CAP }));
    const pattern = [
      assign('ada', DAY_12, '2026-01-05'),
      ...assignRun('ada', NIGHT_12, '2026-01-06', 4),
    ];
    expect(evaluate(encoding, pattern).violated.join('\n')).toMatch(/consecutive nights/);
  });

  it('never adds a fifth night to four nights the manager locked, though a day before them is allowed', () => {
    const locked = assignRun('ada', NIGHT_12, '2026-01-06', 4).map((a) => ({
      ...a,
      isLocked: true,
    }));
    const encoding = encodeCpsat(unit([ada()], { ruleSet: NO_WEEKLY_CAP, assignments: locked }));
    // The locked run already breaks the cap and stays on the report; a Monday day does not
    // lengthen it.
    const withDay = evaluate(encoding, [...locked, assign('ada', DAY_12, '2026-01-05')]);
    expect(withDay.violated.join('\n')).not.toMatch(/consecutive nights/);
    // The window Mon–Thu holds the constant 3 plus Monday's night variable, so it must be <= 3.
    const withNight = evaluate(encoding, [...locked, assign('ada', NIGHT_12, '2026-01-05')]);
    expect(withNight.violated.join('\n')).toMatch(/consecutive nights/);
  });

  it('sees a locked night that shares its date with a locked day', () => {
    // Locked Mon 5: day 07:00 then night 19:00 (the day sorts first); locked nights Tue 6, Wed 7.
    // Night dates 5, 6, 7 are 3 constants, so the window Mon–Thu leaves room for 0 more: a night
    // on Thu 8 makes 4 > 3. Letting the day decide Monday would count it 0 and allow Thursday.
    const locked = [
      assign('ada', DAY_12, '2026-01-05'),
      ...assignRun('ada', NIGHT_12, '2026-01-05', 3),
    ].map((a) => ({ ...a, isLocked: true }));
    const encoding = encodeCpsat(unit([ada()], { ruleSet: NO_WEEKLY_CAP, assignments: locked }));
    const withThursday = evaluate(encoding, [...locked, assign('ada', NIGHT_12, '2026-01-08')]);
    expect(withThursday.violated.join('\n')).toMatch(/consecutive nights: .* from 2026-01-05/);
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

  it('caps a schedule’s first days at the contract less the hours already published', () => {
    // Schedule Sun 11 – Sat 24 Jan; pay period Sun 4 – Sat 17 began before it. Last schedule
    // worked D12 Sun 4 – Thu 8: 60h. Room left: 72 + 4 tolerance − 60 = 16h, one 12 and no more.
    const input = solveInputFrom({
      startDate: isoDate('2026-01-11'),
      endDate: isoDate('2026-01-24'),
      historyFrom: isoDate('2025-12-14'),
      nurses: [makeNurse({ id: 'ana', firstName: 'Ana', contractedHoursPerPeriod: 72 })],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
      priorAssignments: assignRun('ana', DAY_12, '2026-01-04', 5, { periodId: 'prev' }),
    });
    const encoding = encodeCpsat(input);
    const monday = assign('ana', DAY_12, '2026-01-12');
    expect(evaluate(encoding, [monday]).violated).toEqual([]);
    const both = [monday, assign('ana', DAY_12, '2026-01-13')];
    expect(evaluate(encoding, both).violated.join('\n')).toMatch(/contracted hours/);
  });

  describe('which published hours count toward the cap', () => {
    // Schedule Sun 11 – Sat 24 Jan, history whole from 14 Dec; pay period Sun 4 – Sat 17 judged.
    // Published: D12 Sun 4, D12 Mon 5 held over 6h, a day on 5 West Wed 7, D12 Thu 8, standby
    // Fri 9. The contract counts 36h of it, leaving 72 + 4 − 36 = 40h: three 12s fit, four do
    // not. Counting the holdover (42h, room 34), 5 West's day or the standby (48h, room 28) would
    // refuse the third.
    const WEST_DAY = { ...DAY_12, id: 'west-d12', unitId: 'unit-west' };
    const west = busyElsewhere(
      [assign('ana', WEST_DAY, '2026-01-07', { periodId: 'west' })],
      [WEST_DAY],
      '5 West',
    );
    const encodingFor = (ruleSet: RuleSet) =>
      encodeCpsat(
        solveInputFrom({
          startDate: isoDate('2026-01-11'),
          endDate: isoDate('2026-01-24'),
          historyFrom: isoDate('2025-12-14'),
          nurses: [makeNurse({ id: 'ana', firstName: 'Ana', contractedHoursPerPeriod: 72 })],
          shiftTypes: [DAY_12, NIGHT_12, ON_CALL, ...west.shiftTypes],
          coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
          priorAssignments: [
            assign('ana', DAY_12, '2026-01-04', { periodId: 'prev' }),
            assign('ana', DAY_12, '2026-01-05', { periodId: 'prev', holdoverMinutes: 360 }),
            ...west.assignments,
            assign('ana', DAY_12, '2026-01-08', { periodId: 'prev' }),
            assign('ana', ON_CALL, '2026-01-09', { periodId: 'prev' }),
          ],
          ruleSet,
        }),
      );
    const days = (dates: string[]) => dates.map((d) => assign('ana', DAY_12, d));
    const three = days(['2026-01-12', '2026-01-14', '2026-01-16']);

    it('counts a held-over shift by its scheduled hours and leaves out other units and standby', () => {
      const encoding = encodingFor(NO_WEEKLY_CAP);
      expect(evaluate(encoding, three).violated).toEqual([]);
      const four = [...three, ...days(['2026-01-17'])];
      expect(evaluate(encoding, four).violated.join('\n')).toMatch(/contracted hours/);
    });

    it('counts the standby too when the contract credits time on call', () => {
      // 48h published: room 28h, two 12s and not three.
      const encoding = encodingFor(
        withParams('fte-target-hours', { onCallCountsTowardHours: true }, NO_WEEKLY_CAP),
      );
      expect(evaluate(encoding, three.slice(0, 2)).violated).toEqual([]);
      expect(evaluate(encoding, three).violated.join('\n')).toMatch(/contracted hours/);
    });
  });

  describe('overtime judged over the pay period', () => {
    // A 120h contract so only overtime can trip. Three 12s and an 8 in week one is 44h.
    const bigContract = () => makeNurse({ id: 'ada', contractedHoursPerPeriod: 120 });
    const withEight = (options: Partial<SolveScenarioOptions>) =>
      unit([bigContract()], {
        shiftTypes: [DAY_12, NIGHT_12, DAY_8],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
          ...coverageAllWeek(DAY_8, 'RN', 1),
        ],
        ...options,
      });
    const fortnightly = withParams('max-hours-per-week', {
      overtimeByPayPeriod: true,
      payPeriodOvertimeThresholdHours: 80,
    });
    const fortnight = [
      assign('ada', DAY_12, '2026-01-04'),
      assign('ada', DAY_12, '2026-01-06'),
      assign('ada', DAY_12, '2026-01-08'),
      assign('ada', DAY_8, '2026-01-09'),
      assign('ada', DAY_12, '2026-01-12'),
      assign('ada', DAY_12, '2026-01-14'),
      assign('ada', DAY_12, '2026-01-16'),
    ];

    it('allows a 44-hour week in an 80-hour pay period', () => {
      const weekly = encodeCpsat(withEight({}));
      expect(evaluate(weekly, fortnight).violated.join('\n')).toMatch(/weekly hours/);
      const encoding = encodeCpsat(withEight({ ruleSet: fortnightly }));
      expect(evaluate(encoding, fortnight).violated).toEqual([]);
    });

    it('forbids the twelve that takes the pay period to 92 hours', () => {
      const encoding = encodeCpsat(withEight({ ruleSet: fortnightly }));
      const extra = [...fortnight, assign('ada', DAY_12, '2026-01-17')];
      expect(evaluate(encoding, extra).violated.join('\n')).toMatch(/overtime: .* pay period/);
    });
  });
});

describe('a holdover in the lookback and the weekly overtime cap', () => {
  it("lets a day 8 in beside a shift held over two hours: the holdover's hours are authorised", () => {
    // Wednesday work week, Wed 31 Dec – Tue 6 Jan. Scheduled 12 + 8 + 12 + 8 = 40h; worked 42h
    // with Thursday's 2h holdover. The cap is 40 + the 2h the holdover authorises = 42.
    const ruleSet = withParams('max-hours-per-week', { workWeekStartsOn: 3 });
    const prior = [
      assign('ada', DAY_12, '2025-12-31', { periodId: 'prev', isLocked: true }),
      assign('ada', DAY_8, '2026-01-01', {
        periodId: 'prev',
        isLocked: true,
        holdoverMinutes: 120,
        holdoverMandated: true,
      }),
    ];
    const input = unit(
      [makeNurse({ id: 'ada', firstName: 'Ada', contractedHoursPerPeriod: 120 })],
      {
        ruleSet,
        priorAssignments: prior,
        shiftTypes: [DAY_12, NIGHT_12, DAY_8],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
          ...coverageAllWeek(DAY_8, 'RN', 1),
        ],
      },
    );
    const encoding = encodeCpsat(input);
    const week = [assign('ada', DAY_12, '2026-01-04'), assign('ada', DAY_8, '2026-01-05')];
    expect(evaluate(encoding, week).violated).toEqual([]);

    const model = encoding.solverModel;
    const view = new ScheduleView({
      period: input.period,
      assignments: week,
      priorAssignments: input.priorAssignments,
      nurses: model.nurses,
      shiftTypes: model.shiftTypes,
    });
    const rules = evaluateSchedule(view, input.ruleSet, model.ctx).hardViolations;
    expect(rules.filter((v) => v.code === 'unauthorised_overtime')).toEqual([]);
  });
});

describe('who runs the shift', () => {
  it('counts a shift run by an LPN as missing its charge nurse, as the rules do', () => {
    // Monday's day 12: Lena, a charge-eligible LPN, and Ana, an RN who is not charge-eligible.
    // Under the default only an RN may run the shift, so nobody on it can take charge.
    const input = solveInputFrom({
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-05'),
      nurses: [
        makeNurse({ id: 'lena', role: 'LPN', isChargeEligible: true }),
        makeNurse({ id: 'ana' }),
      ],
      shiftTypes: [DAY_12],
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
    });
    const roster = [assign('lena', DAY_12, '2026-01-05'), assign('ana', DAY_12, '2026-01-05')];
    const encoding = encodeCpsat(input);
    const { values } = evaluate(encoding, roster);
    const missing = values.findIndex(
      (_, v) => encoding.builder.label(v) === 'missing charge: D12 2026-01-05',
    );
    expect(missing).toBeGreaterThanOrEqual(0);
    expect(values[missing]).toBe(1);

    const model = new SolverModel(input);
    const view = new ScheduleView({
      period: input.period,
      assignments: roster,
      nurses: model.nurses,
      shiftTypes: model.shiftTypes,
    });
    const codes = evaluateSchedule(view, input.ruleSet, model.ctx).violations.map((v) => v.code);
    expect(codes).toContain('missing_charge_nurse');
  });
});

describe('agreement with the rule engine', () => {
  /** Mixed 8/12-hour shifts, on-call and a lookback tail, for two nurses. */
  const parityInput = (options: Partial<SolveScenarioOptions> = {}) =>
    solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [ada(), makeNurse({ id: 'bo', firstName: 'Bo', contractedHoursPerPeriod: 48 })],
      shiftTypes: [DAY_12, NIGHT_12, DAY_8, EVENING_8, ON_CALL],
      coverageRequirements: [
        ...coverageAllWeek(DAY_12, 'RN', 1),
        ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ...coverageAllWeek(DAY_8, 'RN', 1),
        ...coverageAllWeek(EVENING_8, 'RN', 1),
        ...coverageAllWeek(ON_CALL, 'RN', 1),
      ],
      priorAssignments: [assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' })],
      ...options,
    });

  /**
   * A roster drawn over the encoding's variables: each nurse-day worked with chance `density`,
   * on one of that day's variables. Locked rows are constants, so they are never drawn.
   */
  function rosterDrawer(encoding: CpsatEncoding) {
    const byNurseDay = new Map<string, typeof encoding.shiftVars>();
    for (const sv of encoding.shiftVars) {
      const key = `${sv.nurseId}|${sv.shift.dateIdx}`;
      byNurseDay.set(key, [...(byNurseDay.get(key) ?? []), sv]);
    }
    return (rng: Rng): Assignment[] => {
      const density = 0.2 + 0.6 * rng.nextFloat();
      const chosen = [...byNurseDay.values()].flatMap((options) =>
        rng.chance(density) ? [options[rng.nextInt(0, options.length - 1)]!] : [],
      );
      return chosen.map((sv) => assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
    };
  }

  /**
   * Decode the values that describe `roster` and expect the schedule to be the roster plus the
   * locked rows, whatever order the shifts were judged in. Decode judges the finished roster
   * through the gate, so a legal roster it refuses is an order or gate defect.
   */
  function expectDecodes(
    input: SolveInput,
    encoding: CpsatEncoding,
    roster: readonly Assignment[],
    verdict: string,
  ): void {
    const values = new Array<number>(encoding.builder.variableCount).fill(0);
    for (const [variable, value] of decisionsFor(encoding, roster)) values[variable] = value;
    const keys = (rows: readonly Assignment[]) =>
      rows.map((a) => `${a.nurseId}|${a.date}|${a.shiftTypeId}`).sort();
    let decoded: string[];
    try {
      decoded = keys(decodeCpsat(input, encoding, values).assignments());
    } catch (err) {
      throw new Error(`${verdict}; decode refused it: ${(err as Error).message}`);
    }
    const locked = input.assignments.filter((a) => a.isLocked);
    expect(decoded, verdict).toEqual(keys([...roster, ...locked]));
  }

  /** Hundreds of random rosters, each judged twice: by the encoding and by the real rules. */
  function expectParity(input: SolveInput): void {
    const encoding = encodeCpsat(input);
    const model = encoding.solverModel;
    const rng = new Rng(7);
    const draw = rosterDrawer(encoding);
    let illegal = 0;
    for (let trial = 0; trial < 400; trial++) {
      const assignments = draw(rng);
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
      if (ruleViolations.length === 0) expectDecodes(input, encoding, assignments, verdict);
    }
    // The generator must produce both kinds, or the agreement proves nothing.
    expect(illegal).toBeGreaterThan(50);
    expect(illegal).toBeLessThan(390);
  }

  /**
   * 1–3 locked shifts for about half the team, on distinct dates of a random type. Some of them
   * break a hard rule on their own (a locked night before a locked day), as a manager's can.
   */
  function withRandomLocks(input: SolveInput, rng: Rng): SolveInput {
    const dates: string[] = [];
    for (let d = input.period.startDate; d <= input.period.endDate; d = addDays(d, 1)) {
      dates.push(d);
    }
    const locks: Assignment[] = [];
    for (const nurse of input.nurses) {
      if (!rng.chance(0.5)) continue;
      const count = rng.nextInt(1, 3);
      const picked = new Set<string>();
      while (picked.size < count) picked.add(dates[rng.nextInt(0, dates.length - 1)]!);
      for (const date of picked) {
        const type = input.shiftTypes[rng.nextInt(0, input.shiftTypes.length - 1)]!;
        locks.push(
          assign(nurse.id, type, date, { id: `lock-${nurse.id}-${date}`, isLocked: true }),
        );
      }
    }
    return { ...input, assignments: [...input.assignments, ...locks] };
  }

  /**
   * Random rosters around random locked shifts. One-directional: CP-SAT forbids anything that
   * adds to a breach the locks already carry, which is stricter than the gate (it tolerates a
   * pinned breach that does not grow), so an encoding-illegal roster may be gate-legal. The
   * other way round is a bug: a roster the encoding accepts must pass the gate and decode.
   */
  function expectLockedParity(input: SolveInput): void {
    const encoding = encodeCpsat(input);
    const rng = new Rng(7);
    const draw = rosterDrawer(encoding);
    let encodingLegal = 0;
    let gateIllegal = 0;
    for (let trial = 0; trial < 400; trial++) {
      const roster = draw(rng);
      const model = new SolverModel(input);
      for (const a of roster) model.add({ ...a });
      const breaches = model.nurses.flatMap((_, n) => model.gateBreaches(n));
      if (breaches.length > 0) gateIllegal++;
      const encoded = evaluate(encoding, roster).violated;
      if (encoded.length > 0) continue;
      encodingLegal++;
      const verdict = `trial ${trial}: encoding says legal; gate says ${breaches.map((v) => v.message).join(' | ') || 'legal'}`;
      expect(breaches, verdict).toEqual([]);
      expectDecodes(input, encoding, roster, verdict);
    }
    // Both kinds, or the check proves nothing.
    expect(encodingLegal).toBeGreaterThanOrEqual(20);
    expect(gateIllegal).toBeGreaterThanOrEqual(20);
  }

  it('calls a random schedule illegal exactly when the rule engine does', () => {
    expectParity(parityInput());
  });

  it('never calls a roster with random locked shifts legal when the rule engine does not', () => {
    expectLockedParity(withRandomLocks(parityInput(), new Rng(31)));
  });

  describe('can always leave every shift unassigned, whatever is locked', () => {
    /**
     * Dana's locked night Mon 5 Jan ends 07:00 Tue, when her locked day starts: 0 hours' rest.
     * Her locked night Fri 9 Jan starts 19:00, inside her Friday 18:00 → Saturday 18:00 block.
     */
    const lockedBreaches = () =>
      solveInputFrom({
        startDate: isoDate('2026-01-04'),
        endDate: isoDate('2026-01-17'),
        nurses: [
          makeNurse({ id: 'dana', firstName: 'Dana' }),
          makeNurse({ id: 'eve', firstName: 'Eve', isChargeEligible: true }),
        ],
        shiftTypes: [DAY_12, NIGHT_12],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
        ],
        assignments: [
          assign('dana', NIGHT_12, '2026-01-05', { id: 'mon-night', isLocked: true }),
          assign('dana', DAY_12, '2026-01-06', { id: 'tue-day', isLocked: true }),
          assign('dana', NIGHT_12, '2026-01-09', { id: 'fri-night', isLocked: true }),
        ],
        availabilityBlocks: [
          {
            id: 'sabbath',
            unitId: UNIT_ID,
            nurseId: 'dana',
            weekdays: [5],
            startTime: '18:00',
            endTime: '18:00',
            reason: 'Sabbath',
          },
        ],
      });

    const allOff = (input: SolveInput) => {
      const encoding = encodeCpsat(input);
      return encoding.builder.evaluate(new Map(), encoding.objectiveScale).violated;
    };

    it('with nothing locked', () => {
      expect(allOff(parityInput())).toEqual([]);
    });

    it('with random locked shifts', () => {
      expect(allOff(withRandomLocks(parityInput(), new Rng(31)))).toEqual([]);
    });

    it('with locked shifts that already break the rest and availability rules', () => {
      const input = lockedBreaches();
      // The pins really do breach, so a model that refused them would be INFEASIBLE.
      expect(lockedHardViolations(input).map((v) => v.code)).toContain('insufficient_rest');
      expect(allOff(input)).toEqual([]);
    });
  });

  it('agrees with the rules when a waived turnaround and a longer rest after nights meet', () => {
    const waiver = (nurseId: string, date: string) => ({
      id: `w-${nurseId}-${date}`,
      unitId: UNIT_ID,
      nurseId,
      date: isoDate(date),
      reason: 'Signed waiver',
      createdAt: 0,
    });
    const waived = parityInput({
      ruleSet: withParams('min-rest-between-shifts', { minRestHoursAfterNight: 36 }),
      restWaivers: [
        waiver('ada', '2026-01-06'),
        waiver('ada', '2026-01-09'),
        waiver('bo', '2026-01-12'),
      ],
    });
    expectParity(waived);
    // And with random locked shifts around the waivers: one-directional, as locks make it.
    expectLockedParity(withRandomLocks(waived, new Rng(31)));
  });

  it('agrees with the rule engine when a held-over lookback shift authorises overtime', () => {
    // Ada's lookback night on Sat 3 Jan was held over an hour: 13 worked hours in the week the
    // schedule opens, one of them overtime the holdover itself authorised.
    expectParity(
      parityInput({
        ruleSet: withParams('max-hours-per-week', { requireOvertimeAuthorisation: true }),
        priorAssignments: [
          assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev', holdoverMinutes: 60 }),
        ],
      }),
    );
  });

  it('agrees with the rule engine when the nurse also works on another unit', () => {
    // Ada works 5 West's day 8 on Wed 7 Jan and its night 12 on Sat 10 Jan. She keeps her home
    // variables on those days, so Wednesday's home night is a night date beside a constant day.
    // Four hours' rest lets that night follow the day 8 (out 15:00, back 19:00), and one night in
    // a row makes it count: a home night Wed then Thu is two, wherever the day 8 sits. Weekly
    // caps are lifted, or the 44 hours that week would hide the nights.
    const west = busyElsewhere(
      [assign('ada', DAY_8, '2026-01-07'), assign('ada', NIGHT_12, '2026-01-10')],
      [DAY_8, NIGHT_12],
      '5 West',
    );
    const base = parityInput({
      ruleSet: withParams(
        'max-consecutive-shifts',
        { maxConsecutiveNights: 1 },
        withParams('min-rest-between-shifts', { minRestHours: 4 }, NO_WEEKLY_CAP),
      ),
    });
    const input: SolveInput = {
      ...base,
      shiftTypes: [...base.shiftTypes, ...west.shiftTypes],
      priorAssignments: [...base.priorAssignments, ...west.assignments],
    };
    const encoding = encodeCpsat(input);
    expect(hasVariable(encoding, 'ada', '2026-01-07', NIGHT_12.id)).toBe(true);
    // Random rosters seldom hold exactly this pair with nothing else wrong, so it is pinned too.
    const nights = [assign('ada', NIGHT_12, '2026-01-07'), assign('ada', NIGHT_12, '2026-01-08')];
    expect(evaluate(encoding, nights).violated).toEqual([
      'consecutive nights: Ada Test 2 nights from 2026-01-07',
    ]);
    expectParity(input);
  });

  /** A paid vacation for Ada and a paid sick call for Bo, both inside the first pay period. */
  const paidLeave: Partial<SolveScenarioOptions> = {
    timeOff: [timeOff('ada', '2026-01-08', '2026-01-09', { paidHours: 20 })],
    paidSickCalls: [{ nurseId: 'bo', date: isoDate('2026-01-12'), hours: 12 }],
  };

  it('agrees with the rules when paid leave counts toward contracted hours', () => {
    expectParity(parityInput(paidLeave));
  });

  it('agrees with the rules when leave counts toward overtime and a day off is a calendar day', () => {
    const ruleSet = withParams(
      'approved-time-off-is-absolute',
      { nightShiftEndingOnLeaveCounts: true },
      withParams('max-hours-per-week', { paidLeaveCountsTowardOvertime: true }),
    );
    expectParity(parityInput({ ...paidLeave, ruleSet }));
  });

  it('agrees with the rules when the holiday rotation is hard', () => {
    // Ada worked last year's Winter Day; the eve before the period pairs with its first day,
    // and Ada's lookback night falls on the eve.
    const h = (
      id: string,
      date: string,
      name: string,
      isMajor: boolean,
      paired: string | null,
    ) => ({
      id,
      unitId: UNIT_ID,
      date: isoDate(date),
      name,
      isMajor,
      pairedHolidayId: paired,
    });
    const base = withParams('holiday-rotation', { pairMinorWithMajor: true });
    const ruleSet: RuleSet = {
      ...base,
      configs: base.configs.map((c) =>
        c.ruleId === 'holiday-rotation' ? { ...c, severityOverride: 'hard' as const } : c,
      ),
    };
    expectParity(
      parityInput({
        ruleSet,
        holidays: [
          h('winter-25', '2025-01-08', 'Winter Day', true, null),
          h('winter-26', '2026-01-08', 'Winter Day', true, null),
          h('eve-26', '2026-01-03', 'First Eve', false, 'first-26'),
          h('first-26', '2026-01-04', 'First Day', true, null),
          h('mid-eve', '2026-01-12', 'Mid Eve', false, 'mid-26'),
          h('mid-26', '2026-01-13', 'Mid Day', true, null),
        ],
        holidayWork: [{ holidayId: 'winter-25', nurseId: 'ada' }],
      }),
    );
  });

  it('agrees with the rules when days asked off must stay off', () => {
    const base = parityInput({
      timeOff: [timeOff('ada', '2026-01-07', '2026-01-09', { status: 'pending' })],
    });
    expectParity({
      ...base,
      ruleSet: {
        ...base.ruleSet,
        configs: base.ruleSet.configs.map((c) =>
          c.ruleId === 'avoid-pending-time-off' ? { ...c, severityOverride: 'hard' as const } : c,
        ),
      },
    });
  });

  it('agrees with the rules when days off after nights are hard', () => {
    const base = parityInput();
    expectParity({
      ...base,
      ruleSet: {
        ...base.ruleSet,
        configs: base.ruleSet.configs.map((c) =>
          c.ruleId === 'recovery-after-nights' ? { ...c, severityOverride: 'hard' as const } : c,
        ),
      },
    });
  });

  it('agrees with the rules when tour rotation limits are hard', () => {
    const base = parityInput({
      nurses: [
        makeNurse({ id: 'ada', firstName: 'Ada', isChargeEligible: true }),
        makeNurse({
          id: 'bo',
          firstName: 'Bo',
          contractedHoursPerPeriod: 48,
          permanentTour: 'day',
        }),
      ],
    });
    expectParity({
      ...base,
      ruleSet: {
        ...base.ruleSet,
        configs: base.ruleSet.configs.map((c) =>
          c.ruleId === 'tour-rotation'
            ? { ...c, enabled: true, severityOverride: 'hard' as const }
            : c,
        ),
      },
    });
  });

  it('agrees that a career nurse exempt from rotation may not work nights then days', () => {
    // The schedule starts Sun 4 Jan 2026: Ada's seniority from 1 Jan 2015 is 11 years, Bo's from
    // 1 Jan 2017 nine. Two tours are allowed, but ten years exempts a nurse to one.
    const input = parityInput({
      nurses: [
        makeNurse({
          id: 'ada',
          firstName: 'Ada',
          isChargeEligible: true,
          seniorityDate: isoDate('2015-01-01'),
        }),
        makeNurse({ id: 'bo', firstName: 'Bo', seniorityDate: isoDate('2017-01-01') }),
      ],
      priorAssignments: [],
    });
    const ruleSet = {
      ...input.ruleSet,
      configs: input.ruleSet.configs.map((c) =>
        c.ruleId === 'tour-rotation'
          ? {
              ...c,
              enabled: true,
              severityOverride: 'hard' as const,
              params: { ...c.params, maxToursPerPeriod: 2, exemptAfterYearsOfService: 10 },
            }
          : c,
      ),
    };
    const encoding = encodeCpsat({ ...input, ruleSet });
    const model = encoding.solverModel;
    // Night Mon 5 Jan, then a day Thu 15 Jan: ten days apart, so only the tour count can object.
    const judge = (nurseId: string) => {
      const n = model.nurses.findIndex((x) => x.id === nurseId);
      model.add(model.make(n, model.shiftAt(1, NIGHT_12)));
      const sa = model.canAdd(n, model.make(n, model.shiftAt(11, DAY_12)));
      const cpsat = evaluate(encoding, [
        assign(nurseId, NIGHT_12, '2026-01-05'),
        assign(nurseId, DAY_12, '2026-01-15'),
      ]).violated;
      return { sa, cpsat };
    };
    const career = judge('ada');
    expect(career.sa).toBe(false);
    expect(career.cpsat.join('\n')).toMatch(/tours per schedule: Ada/);
    const midCareer = judge('bo');
    expect(midCareer.sa).toBe(true);
    expect(midCareer.cpsat).toEqual([]);
  });

  it('agrees that a career nurse on permanent nights stays on nights though the unit does not enforce it', () => {
    // As above: Ada has 11 years at Sun 4 Jan 2026, Bo nine; both are on permanent nights.
    const input = parityInput({
      nurses: [
        makeNurse({
          id: 'ada',
          firstName: 'Ada',
          isChargeEligible: true,
          seniorityDate: isoDate('2015-01-01'),
          permanentTour: 'night',
        }),
        makeNurse({
          id: 'bo',
          firstName: 'Bo',
          seniorityDate: isoDate('2017-01-01'),
          permanentTour: 'night',
        }),
      ],
      priorAssignments: [],
    });
    const ruleSet = {
      ...input.ruleSet,
      configs: input.ruleSet.configs.map((c) =>
        c.ruleId === 'tour-rotation'
          ? {
              ...c,
              enabled: true,
              severityOverride: 'hard' as const,
              params: { ...c.params, permanentTourEnforced: false, exemptAfterYearsOfService: 10 },
            }
          : c,
      ),
    };
    const encoding = encodeCpsat({ ...input, ruleSet });
    const model = encoding.solverModel;
    // A lone day 12 on Mon 12 Jan: nothing but the permanent tour can object to it.
    const judge = (nurseId: string) => {
      const n = model.nurses.findIndex((x) => x.id === nurseId);
      const sa = model.canAdd(n, model.make(n, model.shiftAt(8, DAY_12)));
      const cpsat = evaluate(encoding, [assign(nurseId, DAY_12, '2026-01-12')]).violated;
      return { sa, cpsat };
    };
    const career = judge('ada');
    expect(career.sa).toBe(false);
    expect(career.cpsat.join('\n')).toMatch(/permanent tour: Ada/);
    const midCareer = judge('bo');
    expect(midCareer.sa).toBe(true);
    expect(midCareer.cpsat).toEqual([]);
  });

  it('agrees with the rules when the most hours in any 24 is hard', () => {
    const base = parityInput();
    expectParity({ ...base, ruleSet: hardHoursIn24(14) });
  });

  it('agrees with the rules when long stretches and the rest after them are hard', () => {
    const base = parityInput();
    expectParity({
      ...base,
      ruleSet: hardLongStretch({ maxConsecutiveHours: 14, restAfterHours: 12, restHours: 14 }),
    });
  });

  it('agrees with the rules when breaks of an hour bridge a stretch', () => {
    // One shift a day keeps a day 8 and a late 8 apart, so the bridged gap a random roster can
    // build is a night 12 ending 07:00 and a late day 8 at 07:30 the next day.
    const types = [DAY_12, NIGHT_12, DAY_8, LATE_8, LATE_DAY_8, ON_CALL];
    const base = parityInput({
      shiftTypes: types,
      coverageRequirements: types.flatMap((t) => coverageAllWeek(t, 'RN', 1)),
    });
    expectParity({
      ...base,
      ruleSet: hardLongStretch({
        maxConsecutiveHours: 14,
        restAfterHours: 12,
        restHours: 14,
        maxBreakMinutesInStretch: 60,
      }),
    });
  });

  it('agrees with the rules when only the bridge decides the cap', () => {
    // With no rest limit, a night 12 and a late day 8 the next morning are 12 and 8 apart but
    // 12 + 8 = 20 together: legal under a 14-hour cap only if the half-hour break ends the stretch.
    const types = [DAY_12, NIGHT_12, DAY_8, LATE_DAY_8, ON_CALL];
    const base = parityInput({
      shiftTypes: types,
      coverageRequirements: types.flatMap((t) => coverageAllWeek(t, 'RN', 1)),
    });
    expectParity({
      ...base,
      ruleSet: hardLongStretch({ maxConsecutiveHours: 14, maxBreakMinutesInStretch: 60 }),
    });
  });

  it.each([
    ['60 minutes', AT_0800],
    ['61 minutes', AT_0801],
  ])(
    'agrees with the rules when a day starts %s after a night ends, under a 60-minute bridge',
    (_label, late) => {
      // 08:00 is 60 minutes after a night 12 ends (joins, 12 + 8 = 20 > 14); 08:01 is 61 (apart).
      const types = [DAY_12, NIGHT_12, DAY_8, late, ON_CALL];
      const base = parityInput({
        shiftTypes: types,
        coverageRequirements: types.flatMap((t) => coverageAllWeek(t, 'RN', 1)),
      });
      expectParity({
        ...base,
        ruleSet: hardLongStretch({ maxConsecutiveHours: 14, maxBreakMinutesInStretch: 60 }),
      });
    },
  );

  it('agrees with the rules when only the bridge decides the rest', () => {
    // Night 12 Mon and late day 8 Tue are 20 worked hours bridged, which earns 16 off: out at
    // 15:30 Tue, so a day at 07:00 Wed (15.5 hours later) is too soon. Unbridged, 12 and 8 earn
    // nothing.
    const types = [DAY_12, NIGHT_12, DAY_8, LATE_DAY_8, ON_CALL];
    const base = parityInput({
      shiftTypes: types,
      coverageRequirements: types.flatMap((t) => coverageAllWeek(t, 'RN', 1)),
    });
    expectParity({
      ...base,
      ruleSet: hardLongStretch({ restAfterHours: 16, restHours: 16, maxBreakMinutesInStretch: 60 }),
    });
  });

  it('agrees with the rules when weekends in a row and per schedule are hard', () => {
    // Ada's lookback night on Sat 3 Jan starts a run; three weekends in the period.
    const ruleSet = withParams('weekend-pattern', {
      maxConsecutiveWeekends: 1,
      maxWeekendsPerPeriod: 1,
    });
    expectParity(
      parityInput({
        ruleSet: {
          ...ruleSet,
          configs: ruleSet.configs.map((c) =>
            c.ruleId === 'weekend-pattern'
              ? { ...c, enabled: true, severityOverride: 'hard' as const }
              : c,
          ),
        },
      }),
    );
  });

  it('agrees with the rules when weekends in any four weeks are hard', () => {
    // Ada's lookback night on Sat 3 Jan is one of the four weekends to 17 Jan.
    const ruleSet = withParams('weekend-pattern', {
      maxConsecutiveWeekends: 3,
      maxWeekendsPer4Weeks: 2,
    });
    const input = parityInput({
      ruleSet: {
        ...ruleSet,
        configs: ruleSet.configs.map((c) =>
          c.ruleId === 'weekend-pattern'
            ? { ...c, enabled: true, severityOverride: 'hard' as const }
            : c,
        ),
      },
    });
    const encoding = encodeCpsat(input);
    const window = /weekends in any four weeks: Ada/;
    // 3 Jan (last schedule), 10 and 17 Jan: three of four. 10 Jan alone: two.
    const third = [assign('ada', DAY_12, '2026-01-10'), assign('ada', DAY_12, '2026-01-17')];
    expect(evaluate(encoding, third).violated.join('\n')).toMatch(window);
    expect(evaluate(encoding, third.slice(0, 1)).violated.join('\n')).not.toMatch(window);
    expectParity(input);
  });

  it('agrees with the rules when two days off together are hard', () => {
    // Day 12s only (standby would halve how densely a random roster works), with every other
    // cap a dense roster would hit lifted, so this rule is what decides. Ada's lookback day on
    // Sat 3 Jan sits in the previous pay period, so it no longer credits the first weekend (D5);
    // both sides must agree it does not. Bo's 5 West day on Thu 8 Jan is a day worked, not a day
    // off, for both.
    const relaxed = withParams(
      'max-consecutive-shifts',
      { maxConsecutiveShifts: 14, minDaysOffAfterMaxStretch: 0 },
      withParams('fte-target-hours', { overToleranceHours: 200 }, NO_WEEKLY_CAP),
    );
    const WEST_DAY = { ...DAY_12, id: 'west-d12', unitId: 'unit-west' };
    const west = busyElsewhere(
      [assign('bo', WEST_DAY, '2026-01-08', { id: 'w-bo', periodId: 'west' })],
      [WEST_DAY],
      '5 West',
    );
    expectParity(
      parityInput({
        shiftTypes: [DAY_12, ...west.shiftTypes],
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
        priorAssignments: [
          assign('ada', DAY_12, '2026-01-03', { periodId: 'prev' }),
          ...west.assignments,
        ],
        ruleSet: hardDaysOff(relaxed),
      }),
    );
  });

  it('agrees with the rules on two days off in a pay period the schedule opens in', () => {
    // Schedule Wed 7 – Sat 17 Jan, history complete from 10 Dec, so the pay period Sun 4 – Sat 17
    // is judged whole. Both worked its first weekend on the published Sun 4. Ada's Mon 5 leaves
    // Tue 6 a day off whose pair turns on Wed 7; Bo's Tue 6 leaves Mon 5 a day off with no pair.
    // Both sides must read those days from the lookback alike.
    const relaxed = withParams(
      'max-consecutive-shifts',
      { maxConsecutiveShifts: 14, minDaysOffAfterMaxStretch: 0 },
      withParams('fte-target-hours', { overToleranceHours: 200 }, NO_WEEKLY_CAP),
    );
    expectParity(
      parityInput({
        startDate: isoDate('2026-01-07'),
        historyFrom: isoDate('2025-12-10'),
        shiftTypes: [DAY_12],
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
        priorAssignments: [
          assign('ada', DAY_12, '2026-01-04', { periodId: 'prev' }),
          assign('ada', DAY_12, '2026-01-05', { periodId: 'prev' }),
          assign('bo', DAY_12, '2026-01-04', { periodId: 'prev' }),
          assign('bo', DAY_12, '2026-01-06', { periodId: 'prev' }),
        ],
        ruleSet: hardDaysOff(relaxed),
      }),
    );
  });

  it('agrees with the rules when nurses are on the 72/80 and Baylor plans', () => {
    // Bo is on leave Monday to Thursday, so his random shifts fall mostly on days his plan can
    // use; a Friday day or a Day 8 is still off it, as a Day 8 is for Ada. One 8-hour type, not
    // two, and weekly caps lifted, or nearly every random roster is illegal and parity proves
    // little.
    const weekdays = (from: string) => timeOff('bo', from, addDays(isoDate(from), 3));
    expectParity(
      parityInput({
        nurses: [
          makeNurse({
            id: 'ada',
            firstName: 'Ada',
            isChargeEligible: true,
            scheduleKind: 'va_72_80',
          }),
          makeNurse({
            id: 'bo',
            firstName: 'Bo',
            contractedHoursPerPeriod: 48,
            scheduleKind: 'va_baylor',
          }),
        ],
        shiftTypes: [DAY_12, NIGHT_12, DAY_8, ON_CALL],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1),
          ...coverageAllWeek(NIGHT_12, 'RN', 1),
          ...coverageAllWeek(DAY_8, 'RN', 1),
          ...coverageAllWeek(ON_CALL, 'RN', 1),
        ],
        timeOff: [weekdays('2026-01-05'), weekdays('2026-01-12')],
        ruleSet: NO_WEEKLY_CAP,
      }),
    );
  });

  it('agrees with the rules when overtime is judged over the pay period', () => {
    // 60h a pay period, so the threshold binds below both nurses' contract caps.
    const ruleSet = withParams('max-hours-per-week', {
      overtimeByPayPeriod: true,
      payPeriodOvertimeThresholdHours: 60,
      paidLeaveCountsTowardOvertime: true,
    });
    expectParity(parityInput({ ...paidLeave, ruleSet }));
  });

  it('agrees with the rules on a pay period the schedule opens in, judged with its history', () => {
    // Schedule Wed 7 – Sat 17 Jan, inside the pay period Sun 4 – Sat 17; history is complete from
    // 10 Dec, so the whole pay period is judged. Bo worked D12 Sun 4 and Mon 5 (24h), leaving
    // 48 + 4 − 24 = 28h of his contract for the schedule's eleven days.
    expectParity(
      parityInput({
        startDate: isoDate('2026-01-07'),
        historyFrom: isoDate('2025-12-10'),
        priorAssignments: [
          assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' }),
          assign('bo', DAY_12, '2026-01-04', { periodId: 'prev' }),
          assign('bo', DAY_12, '2026-01-05', { periodId: 'prev' }),
        ],
      }),
    );
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
        {
          id: 'h1',
          unitId: UNIT_ID,
          date: isoDate('2026-01-19'),
          name: 'MLK Day',
          isMajor: true,
          pairedHolidayId: null,
        },
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

  it('accepts and prices the same with a Baylor nurse on the team, seed after seed', () => {
    // Nurse 3 on the Baylor plan: weekend tours only, and no weekend or holiday burden.
    const rich = richInput();
    const input: SolveInput = {
      ...rich,
      nurses: rich.nurses.map((n, i) => (i === 3 ? { ...n, scheduleKind: 'va_baylor' } : n)),
    };
    for (const seed of [1, 2]) {
      const report = solve(input, { seed, maxIterations: 4000 });
      const { evaluation, expected } = both(input, report.assignments);
      expect(evaluation.violated).toEqual([]);
      expect(evaluation.objective).toBeCloseTo(expected, 0);
    }
  });

  it('charges no fairness to a Baylor nurse for the weekends and holiday the plan is made of', () => {
    // Bo works Sat 10 (a holiday), Sun 11 and Sat 17: two weekends, one holiday. Cy, on the same
    // contract, works none. Day shifts, no history, no preferences, 36h against a 72h contract:
    // weekends and holidays are the only burden there is. On a standard schedule Bo is over his
    // share of both; on the Baylor plan the team has none to share, so fairness is exactly 0.
    const team = (scheduleKind?: 'va_baylor') =>
      unit(
        [
          makeNurse({ id: 'bo', firstName: 'Bo', isChargeEligible: true, scheduleKind }),
          makeNurse({ id: 'cy', firstName: 'Cy', isChargeEligible: true }),
        ],
        {
          holidays: [
            {
              id: 'h',
              unitId: UNIT_ID,
              date: isoDate('2026-01-10'),
              name: 'Mid Day',
              isMajor: true,
              pairedHolidayId: null,
            },
          ],
        },
      );
    const roster = ['2026-01-10', '2026-01-11', '2026-01-17'].map((d) => assign('bo', DAY_12, d));
    const fairnessOf = (input: SolveInput) => {
      const model = new SolverModel(input);
      for (const a of roster) model.add(a);
      expect(evaluate(encodeCpsat(input), roster).objective).toBeCloseTo(
        model.breakdown().total,
        0,
      );
      return model.breakdown().fairness;
    };
    expect(fairnessOf(team())).toBeGreaterThan(0);
    expect(fairnessOf(team('va_baylor'))).toBe(0);
  });

  describe('a shortage on one shift', () => {
    // Per-diem nurses (no hours pressure) and floors only on Mon 5 Jan.
    function mondayOnly(day: number, night: number, chargeEligible = true): SolveInput {
      return solveInputFrom({
        startDate: isoDate('2026-01-04'),
        endDate: isoDate('2026-01-17'),
        nurses: ['ada', 'bo'].map((id) =>
          makeNurse({
            id,
            isChargeEligible: chargeEligible,
            employmentType: 'per_diem',
            contractedHoursPerPeriod: 0,
          }),
        ),
        shiftTypes: [DAY_12, NIGHT_12],
        coverageRequirements: [
          ...(day > 0 ? [coverage(DAY_12, 'RN', day, day, null, isoDate('2026-01-05'))] : []),
          ...(night > 0
            ? [coverage(NIGHT_12, 'RN', night, night, null, isoDate('2026-01-05'))]
            : []),
        ],
      });
    }

    it('prices a concentrated shortage the same as the annealer', () => {
      const input = mondayOnly(2, 2);
      const stripped = both(input, [
        assign('ada', DAY_12, '2026-01-05'),
        assign('bo', DAY_12, '2026-01-05'),
      ]);
      const spread = both(input, [
        assign('ada', DAY_12, '2026-01-05'),
        assign('bo', NIGHT_12, '2026-01-05'),
      ]);
      for (const { evaluation, expected } of [stripped, spread]) {
        expect(evaluation.violated).toEqual([]);
        expect(evaluation.objective).toBeCloseTo(expected, 0);
      }
      // The night two short (3,000 + 6,000) against each shift one short (3,000 twice).
      expect(stripped.evaluation.objective - spread.evaluation.objective).toBeCloseTo(3000, 0);
    });

    it('prices a shortage two ways in one shift the same as the annealer', () => {
      // Two RNs who cannot take charge on a day 12 with a floor of 3: one slot short and no
      // charge nurse, two units on one shift — 3,000 + 6,000 — and one below target at 60.
      const input = mondayOnly(3, 0, false);
      const roster = [assign('ada', DAY_12, '2026-01-05'), assign('bo', DAY_12, '2026-01-05')];
      const { evaluation, expected } = both(input, roster);
      expect(evaluation.violated).toEqual([]);
      expect(evaluation.objective).toBeCloseTo(expected, 0);
      const model = new SolverModel(input);
      for (const a of roster) model.add(a);
      expect(model.breakdown().coverage).toBe(9_060);
    });
  });

  describe('a mid 8 covered by the day 12', () => {
    // Nurse 0: charge-eligible, experienced, ACLS. Nurse 1: experienced RN, no ACLS.
    // Nurse 5: a new grad. The mid 8 needs one ACLS nurse on the unit during its hours.
    const midInput = (mid = MID_8, nurses = richInput().nurses) => {
      return solveInputFrom({
        startDate: isoDate('2026-01-04'),
        endDate: isoDate('2026-01-24'),
        nurses: [...nurses],
        shiftTypes: [DAY_12, NIGHT_12, mid],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1, 2),
          ...coverageAllWeek(NIGHT_12, 'RN', 1, 1),
          ...coverageAllWeek(mid, 'RN', 1, 1),
        ],
        shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: mid })],
        nurseCredentials: [nurseCredential(nurses[0]!.id, CRED_ACLS)],
      });
    };
    const on = (input: SolveInput, i: number, shift: typeof DAY_12) =>
      assign(input.nurses[i]!.id, shift, '2026-01-05');

    it('prices charge, ACLS and new-grad cover from the day 12 the same', () => {
      const input = midInput();
      const covered = both(input, [on(input, 0, DAY_12), on(input, 5, MID_8)]);
      const noAcls = both(input, [on(input, 1, DAY_12), on(input, 5, MID_8)]);
      const alone = both(input, [on(input, 5, MID_8)]);
      for (const { evaluation, expected } of [covered, noAcls, alone]) {
        expect(evaluation.violated).toEqual([]);
        expect(evaluation.objective).toBeCloseTo(expected, 0);
      }
      // The day 12's ACLS nurse covers the mid 8; an experienced RN without ACLS covers only
      // the new grad; nobody on the day 12 covers neither.
      expect(covered.expected).toBeLessThan(noAcls.expected);
      expect(noAcls.expected).toBeLessThan(alone.expected);
    });

    it('accepts and prices the annealer’s schedules the same, seed after seed', () => {
      const input = midInput();
      for (const seed of [1, 2]) {
        const report = solve(input, { seed, maxIterations: 4000 });
        const { evaluation, expected } = both(input, report.assignments);
        expect(evaluation.violated).toEqual([]);
        expect(evaluation.objective).toBeCloseTo(expected, 0);
      }
    });

    it('costs more when the 8 must carry its own charge and ACLS nurse', () => {
      const inside = midInput();
      const alone = midInput({ ...MID_8, withinShiftTypeId: null }, inside.nurses);
      const schedule = [on(inside, 0, DAY_12), on(inside, 1, MID_8)];
      const insideCost = both(inside, schedule);
      const aloneCost = both(alone, schedule);
      expect(aloneCost.evaluation.objective).toBeCloseTo(aloneCost.expected, 0);
      expect(aloneCost.expected).toBeGreaterThan(insideCost.expected);
    });
  });

  describe('incompatible staff', () => {
    // A clique of three with the lookback night's nurse in it, and a pair from the 10th on:
    // day 8s and evening 8s overlap the day 12 and the night, so stretches are cut every which way.
    const groupInput = (overrides: Partial<SolveScenarioOptions> = {}): SolveInput => {
      const base = richInput();
      const ids = base.nurses.map((n) => n.id);
      return {
        ...base,
        ...(overrides.ruleSet ? { ruleSet: overrides.ruleSet } : {}),
        incompatibilityGroups: [
          {
            id: 'clique',
            unitId: UNIT_ID,
            name: 'Clique',
            nurseIds: [ids[1]!, ids[3]!, ids[5]!],
            maxTogether: 1,
            reason: 'test',
          },
          {
            id: 'pair',
            unitId: UNIT_ID,
            name: 'Pair',
            nurseIds: [ids[0]!, ids[2]!],
            maxTogether: 1,
            reason: 'test',
            startsOn: isoDate('2026-01-10'),
          },
        ],
      };
    };

    it('charges a shared day 12 with one outside nurse by the hour, as worked by hand', () => {
      const input = groupInput();
      const [, b, , d, e] = input.nurses.map((n) => n.id);
      // Wednesday the 14th: clique members b and d on the day 12 with e from outside.
      const schedule = [
        ...input.assignments,
        assign(b!, DAY_12, '2026-01-14'),
        assign(d!, DAY_12, '2026-01-14'),
        assign(e!, DAY_12, '2026-01-14'),
      ];
      const model = new SolverModel(input);
      for (const a of schedule) if (!a.isLocked) model.add({ ...a });
      // One member over the cap for 12h at 50 = 600; one outside nurse short for 12h at
      // 3000 / 12 = 3000.
      expect(model.breakdown().incompatibility).toBeCloseTo(3600, 6);
      const { evaluation, expected } = both(input, schedule);
      expect(evaluation.violated).toEqual([]);
      expect(evaluation.objective).toBeCloseTo(expected, 0);
    });

    it('charges a cap the rule set makes hard like a staffing shortfall', () => {
      const soft = groupInput();
      const hardCap = groupInput({
        ruleSet: {
          ...soft.ruleSet,
          configs: soft.ruleSet.configs.map((c) =>
            c.ruleId === 'incompatible-staff-cap' ? { ...c, severityOverride: 'hard' } : c,
          ),
        },
      });
      const [, b, , d, e, , g] = hardCap.nurses.map((n) => n.id);
      // Two outside nurses, so only the cap is broken: 12h × 3000 / 12 = 3000.
      const schedule = [
        ...hardCap.assignments,
        assign(b!, DAY_12, '2026-01-14'),
        assign(d!, DAY_12, '2026-01-14'),
        assign(e!, DAY_12, '2026-01-14'),
        assign(g!, DAY_12, '2026-01-14'),
      ];
      const model = new SolverModel(hardCap);
      for (const a of schedule) if (!a.isLocked) model.add({ ...a });
      expect(model.breakdown().incompatibility).toBeCloseTo(3000, 6);
      const { evaluation, expected } = both(hardCap, schedule);
      expect(evaluation.objective).toBeCloseTo(expected, 0);
    });

    it('prices random rosters the same as the annealer', () => {
      const input = groupInput();
      const encoding = encodeCpsat(input);
      const rng = new Rng(11);
      let priced = 0;
      for (let trial = 0; trial < 60; trial++) {
        const density = 0.2 + 0.5 * rng.nextFloat();
        const seen = new Set<string>();
        const assignments = [...input.assignments];
        for (const sv of encoding.shiftVars) {
          const day = `${sv.nurseId}|${sv.shift.date}`;
          if (seen.has(day) || !rng.chance(density / 3)) continue;
          seen.add(day);
          assignments.push(assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
        }
        const evaluation = evaluate(encoding, assignments);
        const model = new SolverModel(input);
        for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
        if (model.breakdown().incompatibility > 0) priced++;
        expect(evaluation.objective, `trial ${trial}`).toBeCloseTo(model.breakdown().total, 0);
      }
      // Most rosters must actually put incompatible nurses together, or this proves nothing.
      expect(priced).toBeGreaterThan(40);
    });

    it("accepts the annealer's schedules and prices them the same, seed after seed", () => {
      const input = groupInput();
      for (const seed of [1, 2]) {
        const report = solve(input, { seed, maxIterations: 4000 });
        const { evaluation, expected } = both(input, report.assignments);
        expect(evaluation.violated).toEqual([]);
        expect(evaluation.objective).toBeCloseTo(expected, 0);
      }
    });
  });

  describe('holiday rotation', () => {
    // Last year's MLK Day was worked by nurses 0–2; the Sunday before this year's is a minor
    // holiday paired with it, so nurses working both are priced too.
    const holidayInput = (severity?: 'hard'): SolveInput => {
      const base = richInput();
      const ids = base.nurses.map((n) => n.id);
      const h = (
        id: string,
        date: string,
        name: string,
        isMajor: boolean,
        paired: string | null,
      ) => ({
        id,
        unitId: UNIT_ID,
        date: isoDate(date),
        name,
        isMajor,
        pairedHolidayId: paired,
      });
      return {
        ...base,
        ruleSet: {
          ...base.ruleSet,
          configs: base.ruleSet.configs.map((c) =>
            c.ruleId === 'holiday-rotation'
              ? {
                  ...c,
                  params: { ...c.params, pairMinorWithMajor: true },
                  ...(severity ? { severityOverride: severity } : {}),
                }
              : c,
          ),
        },
        holidays: [
          h('mlk-25', '2025-01-20', 'MLK Day', true, null),
          h('mlk-26', '2026-01-19', 'MLK Day', true, null),
          h('eve-26', '2026-01-18', 'MLK Eve', false, 'mlk-26'),
          // Paired months apart: nurses 3 and 4 worked Labor Day, so MLK Day is the other half's.
          h('labor-25', '2025-09-01', 'Labor Day', false, 'mlk-26'),
        ],
        holidayWork: [
          ...[0, 1, 2].map((i) => ({ holidayId: 'mlk-25', nurseId: ids[i]! })),
          ...[3, 4].map((i) => ({ holidayId: 'labor-25', nurseId: ids[i]! })),
        ],
      };
    };

    it('prices random rosters the same as the annealer', () => {
      const input = holidayInput();
      const encoding = encodeCpsat(input);
      const rng = new Rng(19);
      let breached = 0;
      for (let trial = 0; trial < 60; trial++) {
        const seen = new Set<string>();
        const assignments = [...input.assignments];
        for (const sv of encoding.shiftVars) {
          const day = `${sv.nurseId}|${sv.shift.date}`;
          const onHoliday = sv.shift.date === '2026-01-18' || sv.shift.date === '2026-01-19';
          if (seen.has(day) || !rng.chance(onHoliday ? 0.5 : 0.1)) continue;
          seen.add(day);
          assignments.push(assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
        }
        const evaluation = evaluate(encoding, assignments);
        const model = new SolverModel(input);
        for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
        if (model.holidayBreaches() > 0) breached++;
        expect(evaluation.objective, `trial ${trial}`).toBeCloseTo(model.breakdown().total, 0);
      }
      // Most rosters must actually break the rotation, or this proves nothing.
      expect(breached).toBeGreaterThan(40);
    });

    it("accepts the annealer's schedules and prices them the same", () => {
      const input = holidayInput();
      const report = solve(input, { seed: 1, maxIterations: 4000 });
      const { evaluation, expected } = both(input, report.assignments);
      expect(evaluation.violated).toEqual([]);
      expect(evaluation.objective).toBeCloseTo(expected, 0);
    });

    it('forbids an owed holiday and a pair outright when the rule is hard', () => {
      const input = holidayInput('hard');
      const encoding = encodeCpsat(input);
      // Nurse 0 worked last year's MLK Day; nurse 3 worked Labor Day, paired with this MLK Day;
      // nurses 5 and 6 have no holiday history.
      const [owed, , , laborDay, , fresh, other] = input.nurses.map((n) => n.id);
      expect(
        evaluate(encoding, [...input.assignments, assign(owed!, DAY_12, '2026-01-19')]).violated,
      ).toEqual([expect.stringContaining('holiday owed off')]);
      expect(
        evaluate(encoding, [
          ...input.assignments,
          assign(fresh!, DAY_12, '2026-01-18'),
          assign(fresh!, DAY_12, '2026-01-19'),
        ]).violated,
      ).toEqual([expect.stringContaining('holiday pair')]);
      expect(
        evaluate(encoding, [...input.assignments, assign(laborDay!, DAY_12, '2026-01-19')])
          .violated,
      ).toEqual([expect.stringContaining('Labor Day 2025-09-01 on record')]);
      expect(
        evaluate(encoding, [...input.assignments, assign(other!, DAY_12, '2026-01-19')]).violated,
      ).toEqual([]);
    });
  });

  describe('days asked off, not yet decided', () => {
    it('prices random rosters the same as the annealer', () => {
      const base = richInput();
      const input: SolveInput = {
        ...base,
        timeOff: [
          ...base.timeOff,
          timeOff(base.nurses[0]!.id, '2026-01-05', '2026-01-09', { status: 'pending' }),
          timeOff(base.nurses[3]!.id, '2026-01-12', '2026-01-13', { status: 'pending' }),
        ],
      };
      const encoding = encodeCpsat(input);
      const rng = new Rng(29);
      let onPending = 0;
      for (let trial = 0; trial < 60; trial++) {
        const seen = new Set<string>();
        const assignments = [...input.assignments];
        for (const sv of encoding.shiftVars) {
          const day = `${sv.nurseId}|${sv.shift.date}`;
          if (seen.has(day) || !rng.chance(0.3)) continue;
          seen.add(day);
          assignments.push(assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
        }
        const evaluation = evaluate(encoding, assignments);
        const model = new SolverModel(input);
        for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
        if (model.pendingBreaches() > 0) onPending++;
        expect(evaluation.objective, `trial ${trial}`).toBeCloseTo(model.breakdown().total, 0);
      }
      expect(onPending).toBeGreaterThan(40);
    });
  });

  describe('two charge nurses on one shift', () => {
    it('prices a locked double charge as the annealer does', () => {
      // Ana and Bo are locked onto Monday's day 12, both marked charge; Cy is free, so the
      // shift is CP-SAT's to move. One shift-scope finding is one `hardShortfall` (3000).
      const charged = (boCharge: boolean) =>
        solveInputFrom({
          startDate: isoDate('2026-01-05'),
          endDate: isoDate('2026-01-05'),
          nurses: [
            makeNurse({ id: 'ana', isChargeEligible: true, contractedHoursPerPeriod: 0 }),
            makeNurse({ id: 'bo', isChargeEligible: true, contractedHoursPerPeriod: 0 }),
            makeNurse({ id: 'cy', contractedHoursPerPeriod: 0 }),
          ],
          shiftTypes: [DAY_12],
          coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 2),
          assignments: [
            assign('ana', DAY_12, '2026-01-05', { isLocked: true, isCharge: true }),
            assign('bo', DAY_12, '2026-01-05', { isLocked: true, isCharge: boCharge }),
          ],
        });
      const double = charged(true);
      const single = charged(false);
      const twice = both(double, double.assignments);
      const once = both(single, single.assignments);
      for (const { evaluation, expected } of [twice, once]) {
        expect(evaluation.violated).toEqual([]);
        expect(evaluation.objective).toBeCloseTo(expected, 0);
      }
      expect(twice.expected - once.expected).toBeCloseTo(3000, 6);
    });
  });

  describe('a licensed-nurse ratio pooling RNs and LVNs', () => {
    it('prices random rosters the same as the annealer', () => {
      const nurses = [
        ...Array.from({ length: 6 }, (_, i) => makeNurse({ isChargeEligible: i % 2 === 0 })),
        ...Array.from({ length: 3 }, () => makeNurse({ role: 'LPN' })),
      ];
      const input = solveInputFrom({
        startDate: isoDate('2026-01-04'),
        endDate: isoDate('2026-01-17'),
        nurses,
        shiftTypes: [DAY_12, NIGHT_12],
        coverageRequirements: [
          ...coverageAllWeek(DAY_12, 'RN', 1, 2),
          ...coverageAllWeek(NIGHT_12, 'RN', 1, 1),
        ],
        // 20 patients every day shift at a licensed 1:5, half of them RNs: 4 licensed, 2 RNs.
        ratioRules: [
          {
            id: 'ratio-licensed',
            unitId: UNIT_ID,
            role: 'licensed',
            acuityTierId: null,
            maxPatientsPerNurse: 5,
            minRnShare: 0.5,
            active: true,
          },
        ],
        censusForecasts: Array.from({ length: 14 }, (_, d) =>
          census(addDays(isoDate('2026-01-04'), d), DAY_12, { [TIER_ROUTINE.id]: 20 }),
        ),
      });
      const encoding = encodeCpsat(input);
      const rng = new Rng(41);
      let breaching = 0;
      for (let trial = 0; trial < 60; trial++) {
        const seen = new Set<string>();
        const assignments = [...input.assignments];
        for (const sv of encoding.shiftVars) {
          const day = `${sv.nurseId}|${sv.shift.date}`;
          if (seen.has(day) || !rng.chance(0.35)) continue;
          seen.add(day);
          assignments.push(assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
        }
        const evaluation = evaluate(encoding, assignments);
        const model = new SolverModel(input);
        for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
        const view = new ScheduleView({
          period: input.period,
          assignments: model.assignments(),
          priorAssignments: input.priorAssignments,
          nurses: model.nurses,
          shiftTypes: model.shiftTypes,
        });
        const breaches = evaluateSchedule(view, input.ruleSet, model.ctx).violations.filter(
          (v) => v.code === 'ratio_breach',
        );
        if (
          breaches.some((v) => v.details?.role === 'licensed') &&
          breaches.some((v) => v.details?.standard === 'rn_share')
        )
          breaching++;
        expect(evaluation.objective, `trial ${trial}`).toBeCloseTo(model.breakdown().total, 0);
      }
      // Both kinds of breach must happen together in many rosters, or this proves little.
      expect(breaching).toBeGreaterThan(10);
    });
  });

  describe('orientees with their preceptors', () => {
    it('prices random rosters the same as the annealer', () => {
      const base = richInput();
      // Nurse 5 (the new grad) is oriented by nurse 0 for the first week, nurse 2 after it.
      const input: SolveInput = {
        ...base,
        preceptorships: [
          {
            id: 'pr1',
            unitId: UNIT_ID,
            orienteeId: base.nurses[5]!.id,
            preceptorId: base.nurses[0]!.id,
            startDate: isoDate('2026-01-04'),
            endDate: isoDate('2026-01-10'),
          },
          {
            id: 'pr2',
            unitId: UNIT_ID,
            orienteeId: base.nurses[5]!.id,
            preceptorId: base.nurses[2]!.id,
            startDate: isoDate('2026-01-11'),
            endDate: isoDate('2026-01-24'),
          },
        ],
      };
      const encoding = encodeCpsat(input);
      const rng = new Rng(37);
      let alone = 0;
      for (let trial = 0; trial < 60; trial++) {
        const seen = new Set<string>();
        const assignments = [...input.assignments];
        for (const sv of encoding.shiftVars) {
          const day = `${sv.nurseId}|${sv.shift.date}`;
          if (seen.has(day) || !rng.chance(0.3)) continue;
          seen.add(day);
          assignments.push(assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
        }
        const evaluation = evaluate(encoding, assignments);
        const model = new SolverModel(input);
        for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
        const view = new ScheduleView({
          period: input.period,
          assignments: model.assignments(),
          priorAssignments: input.priorAssignments,
          nurses: model.nurses,
          shiftTypes: model.shiftTypes,
        });
        if (
          evaluateSchedule(view, input.ruleSet, model.ctx).violations.some(
            (v) => v.code === 'orientee_without_preceptor',
          )
        )
          alone++;
        expect(evaluation.objective, `trial ${trial}`).toBeCloseTo(model.breakdown().total, 0);
      }
      // Most rosters must leave the orientee alone somewhere, or this proves nothing.
      expect(alone).toBeGreaterThan(40);
    });
  });

  describe('weekends in a row and per schedule', () => {
    it('prices random rosters the same as the annealer', () => {
      // Nurse 3 is on the Baylor plan, which the weekend pattern does not judge.
      const rich = richInput();
      const base: SolveInput = {
        ...rich,
        nurses: rich.nurses.map((n, i) => (i === 3 ? { ...n, scheduleKind: 'va_baylor' } : n)),
      };
      const rules = withParams(
        'weekend-pattern',
        { maxConsecutiveWeekends: 1, maxWeekendsPerPeriod: 2 },
        base.ruleSet,
      );
      const input: SolveInput = {
        ...base,
        ruleSet: {
          ...rules,
          configs: rules.configs.map((c) =>
            c.ruleId === 'weekend-pattern' ? { ...c, enabled: true } : c,
          ),
        },
      };
      const encoding = encodeCpsat(input);
      const rng = new Rng(31);
      let breaching = 0;
      for (let trial = 0; trial < 60; trial++) {
        const seen = new Set<string>();
        const assignments = [...input.assignments];
        for (const sv of encoding.shiftVars) {
          const day = `${sv.nurseId}|${sv.shift.date}`;
          if (seen.has(day) || !rng.chance(0.3)) continue;
          seen.add(day);
          assignments.push(assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
        }
        const evaluation = evaluate(encoding, assignments);
        const model = new SolverModel(input);
        for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
        if (model.weekendBreaches() > 0) breaching++;
        expect(evaluation.objective, `trial ${trial}`).toBeCloseTo(model.breakdown().total, 0);
      }
      expect(breaching).toBeGreaterThan(40);
    });
  });

  describe('days off after nights', () => {
    it('prices random rosters the same as the annealer', () => {
      const input = richInput();
      const encoding = encodeCpsat(input);
      const rng = new Rng(23);
      let flipped = 0;
      for (let trial = 0; trial < 60; trial++) {
        const seen = new Set<string>();
        const assignments = [...input.assignments];
        for (const sv of encoding.shiftVars) {
          const day = `${sv.nurseId}|${sv.shift.date}`;
          if (seen.has(day) || !rng.chance(0.3)) continue;
          seen.add(day);
          assignments.push(assign(sv.nurseId, sv.shift.shiftType, sv.shift.date));
        }
        const evaluation = evaluate(encoding, assignments);
        const model = new SolverModel(input);
        for (const a of assignments) if (!a.isLocked) model.add({ ...a, isCharge: false });
        if (model.recoveryBreaches() > 0) flipped++;
        expect(evaluation.objective, `trial ${trial}`).toBeCloseTo(model.breakdown().total, 0);
      }
      // Most rosters must actually flip someone from nights to days, or this proves nothing.
      expect(flipped).toBeGreaterThan(40);
    });
  });

  it('prices an empty schedule — every floor short — the same', () => {
    const input = richInput();
    const locked = input.assignments.filter((a) => a.isLocked);
    const { evaluation, expected } = both(input, locked);
    expect(evaluation.violated).toEqual([]);
    expect(evaluation.objective).toBeCloseTo(expected, 0);
  });
});

describe('two nurses who want to work the holiday', () => {
  // MLK Day needs one RN on days and nothing else is staffed. Both per diem volunteer at the same
  // strength; Ana (2010) is senior to Bo (2020) but paid more: 12h at $55 is 33 points against
  // Bo's 12h at $52, 31.2. The reward is half the weight, scaled by seniority: 4 / 2 × 1.5 × 10
  // = 30 for Ana, 4 / 2 × 1 × 10 = 20 for Bo, so Ana nets 3 points to Bo's 11.2 — without the
  // reward Bo is the cheaper pick by 1.8.
  const volunteers = (): SolveInput => {
    const ana = makeNurse({
      id: 'ana',
      employmentType: 'per_diem',
      contractedHoursPerPeriod: 0,
      isChargeEligible: true,
      seniorityDate: isoDate('2010-01-01'),
    });
    const bo = makeNurse({
      id: 'bo',
      employmentType: 'per_diem',
      contractedHoursPerPeriod: 0,
      isChargeEligible: true,
      seniorityDate: isoDate('2020-01-01'),
    });
    const wants = (nurseId: string): Preference => ({
      id: `p-${nurseId}`,
      nurseId,
      kind: 'holiday_appetite',
      holidayId: 'mlk',
      weight: 4,
    });
    return solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      // Bo first, so a tie would not hand Ana the day by roster order.
      nurses: [bo, ana],
      shiftTypes: [DAY_12],
      coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-12'))],
      holidays: [
        {
          id: 'mlk',
          unitId: UNIT_ID,
          date: isoDate('2026-01-12'),
          name: 'MLK Day',
          isMajor: true,
          pairedHolidayId: null,
        },
      ],
      preferences: [wants('bo'), wants('ana')],
      cost: {
        payRates: [payRate(55, { nurseId: 'ana' }), payRate(52, { nurseId: 'bo' })],
        differentials: [],
        overtimeRules: [],
      },
    });
  };
  const worksHoliday = (assignments: readonly Assignment[]) =>
    assignments.filter((a) => a.date === '2026-01-12').map((a) => a.nurseId);

  it('gives the holiday to the senior volunteer in the annealer', () => {
    const report = solve(volunteers(), { seed: 1, maxIterations: 2000 });
    expect(worksHoliday(report.assignments)).toEqual(['ana']);
  });

  it('prices the senior volunteer lower in CP-SAT, as the annealer does', () => {
    const input = volunteers();
    const encoding = encodeCpsat(input);
    const priced = (nurseId: string) => {
      const assignments = [assign(nurseId, DAY_12, '2026-01-12')];
      const evaluation = evaluate(encoding, assignments);
      const model = new SolverModel(input);
      model.add({ ...assignments[0]!, isCharge: false });
      expect(evaluation.violated).toEqual([]);
      expect(evaluation.objective).toBeCloseTo(model.breakdown().total, 0);
      return evaluation.objective;
    };
    // Ana nets 3 points to Bo's 11.2 (see above): 8.2 in Ana's favour.
    expect(priced('bo') - priced('ana')).toBeCloseTo(8.2, 1);
  });

  it('prices a second volunteer on a staffed holiday the same as the annealer', () => {
    // One of them is over MLK Day's target, which costs overTarget plus the larger reward (Ana's
    // 30) in both solvers, so neither pays the other to come in.
    const input = volunteers();
    const encoding = encodeCpsat(input);
    const assignments = [assign('bo', DAY_12, '2026-01-12'), assign('ana', DAY_12, '2026-01-12')];
    const evaluation = evaluate(encoding, assignments);
    const model = new SolverModel(input);
    for (const a of assignments) model.add({ ...a, isCharge: false });
    expect(evaluation.violated).toEqual([]);
    expect(evaluation.objective).toBeCloseTo(model.breakdown().total, 0);
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
    let thrown: unknown;
    try {
      decodeCpsat(input, encoding, values);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EncodingDisagreementError);
    const error = thrown as EncodingDisagreementError;
    expect(error.nurseId).toBe('ada');
    expect(error.breaches.map((v) => v.code)).toEqual(['insufficient_rest']);
  });

  it('judges the answer as one roster, so the order its shifts are listed in cannot matter', () => {
    // Long stretches owe 9 hours off after 8 straight; min-rest is off so back-to-back shifts
    // are allowed. Ada works Wed 7 Jan Day 8 (07–15), Evening 8 (15–23) and Night 8 (23–07):
    // one unbroken 24-hour stretch with nothing after it, which is legal. The evening sorts
    // last, so read row by row the night comes straight after the day's 8 hours with only 8
    // off — a breach the finished roster does not have.
    const BRIDGE = { ...EVENING_8, id: 'st-bridge', sortOrder: 99 };
    const base = defaultRuleSet(UNIT_ID);
    const input = unit([ada()], {
      shiftTypes: [DAY_8, NIGHT_8, BRIDGE],
      coverageRequirements: [
        ...coverageAllWeek(DAY_8, 'RN', 1),
        ...coverageAllWeek(NIGHT_8, 'RN', 1),
        ...coverageAllWeek(BRIDGE, 'RN', 1),
      ],
      ruleSet: {
        ...base,
        configs: base.configs.map((c) =>
          c.ruleId === 'long-stretch'
            ? {
                ...c,
                enabled: true,
                severityOverride: 'hard' as const,
                params: {
                  ...c.params,
                  restAfterHours: 8,
                  restOnlyPastThreshold: false,
                  restHours: 9,
                },
              }
            : c.ruleId === 'min-rest-between-shifts'
              ? { ...c, enabled: false }
              : c,
        ),
      },
    });
    const encoding = encodeCpsat(input);
    const values = new Array<number>(encoding.builder.variableCount).fill(0);
    for (const sv of encoding.shiftVars)
      if (sv.shift.date === '2026-01-07') values[sv.variable] = 1;
    const model = decodeCpsat(input, encoding, values);
    expect(model.assignments().map((a) => `${a.date} ${a.shiftTypeId}`)).toEqual([
      `2026-01-07 ${DAY_8.id}`,
      `2026-01-07 ${NIGHT_8.id}`,
      `2026-01-07 ${BRIDGE.id}`,
    ]);
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

describe('kept-apart staff and other units', () => {
  it('prices a member’s shift here the same whether or not the other member works 5 West that day', () => {
    // Ana and Ben are kept apart (cap 1, two outside staff while they overlap). Ana works the
    // Wednesday day 12 here with Cy and Dee; Ben works 5 West's day 12 the same Wednesday.
    const [ana, ben] = [makeNurse({ id: 'ana' }), makeNurse({ id: 'ben' })];
    const [cy, dee] = [makeNurse({ id: 'cy', isChargeEligible: true }), makeNurse({ id: 'dee' })];
    const WEST_DAY = { ...DAY_12, id: 'west-d12', unitId: 'unit-west' };
    const busy = busyElsewhere(
      [assign(ben.id, WEST_DAY, '2026-01-07', { id: 'w-b', periodId: 'west' })],
      [WEST_DAY],
      '5 West',
    );
    const withoutWest = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [ana, ben, cy, dee],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [coverage(DAY_12, 'RN', 3, 3, null, isoDate('2026-01-07'))],
      incompatibilityGroups: [
        {
          id: 'apart',
          unitId: UNIT_ID,
          name: 'Apart',
          nurseIds: [ana.id, ben.id],
          maxTogether: 1,
          reason: 'test',
        },
      ],
    });
    const withWest: SolveInput = {
      ...withoutWest,
      shiftTypes: [...withoutWest.shiftTypes, ...busy.shiftTypes],
      priorAssignments: [...withoutWest.priorAssignments, ...busy.assignments],
    };
    const schedule = [
      assign(ana.id, DAY_12, '2026-01-07'),
      assign(cy.id, DAY_12, '2026-01-07', { isCharge: true }),
      assign(dee.id, DAY_12, '2026-01-07'),
    ];
    const priced = (input: SolveInput) => {
      const model = new SolverModel(input);
      for (const a of schedule) model.add({ ...a });
      return { model, objective: model.objective() };
    };
    const here = priced(withoutWest);
    const there = priced(withWest);
    // Ben is not on this floor, so Ana has no member beside her: nothing over the cap, no buffer
    // needed. The incompatibility terms are identical, and so is every other term.
    expect(there.objective).toBeCloseTo(here.objective, 6);
    expect(evaluate(encodeCpsat(withWest), schedule).objective).toBeCloseTo(
      evaluate(encodeCpsat(withoutWest), schedule).objective,
      6,
    );
    expect(there.model.stretches.flatMap((s) => s.tail).map((a) => a.id)).not.toContain('w-b');
  });
});
