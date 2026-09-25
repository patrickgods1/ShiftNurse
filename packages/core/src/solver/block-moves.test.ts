/**
 * Block moves: trading or handing over a run of several days at once.
 *
 * The scenario these exist for: a nurse who asked not to work days holds a run of day shifts,
 * and a colleague who asked not to work nights holds the matching run of nights. Every single
 * one-day trade between them is illegal — a night that ends at 07:00 followed by a day shift
 * starting at 07:00 is 0 hours of rest, against 10 required — so a search that only ever moves
 * one shift at a time can see the better schedule but cannot walk to it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse, Preference } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { defaultRuleSet, evaluateSchedule, hardRuleIdsByScope } from '../rules/registry.js';
import { ScheduleView } from '../schedule/view.js';
import {
  assign,
  coverage,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  timeOff,
  UNIT_ID,
} from '../testing/fixtures.js';
import { anneal } from './anneal.js';
import { exchangeBlock } from './block-moves.js';
import { SolverModel } from './model.js';
import { Rng } from './rng.js';

beforeEach(() => {
  resetFixtureCounters();
});

// One whole pay period (Sun 4 – Sat 17 Jan), so each nurse's hours target is their real contract,
// but only Monday to Wednesday is staffed: no weekend in play, and preferences are the only soft
// pressure that differs between the two schedules.
const PERIOD_START = '2026-01-04';
const PERIOD_END = '2026-01-17';
const DATES = ['2026-01-05', '2026-01-06', '2026-01-07'];
/** Date indexes of Monday and Wednesday within the period. */
const MON = 1;
const WED = 3;

interface Setup {
  model: SolverModel;
  x: number;
  y: number;
  z: number;
}

/** X holds three days but avoids days; Y holds three nights but avoids nights; Z is free. */
function trapped(locked: Assignment[] = []): Setup {
  const nurseX = makeNurse({ id: 'nurse-x', firstName: 'Xena' });
  const nurseY = makeNurse({ id: 'nurse-y', firstName: 'Yusuf' });
  const nurseZ = makeNurse({ id: 'nurse-z', firstName: 'Zara' });
  const nurses: Nurse[] = [nurseX, nurseY, nurseZ];
  const preferences: Preference[] = [
    { id: 'p-x', nurseId: 'nurse-x', kind: 'avoid_shift_type', shiftTypeId: DAY_12.id, weight: 5 },
    {
      id: 'p-y',
      nurseId: 'nurse-y',
      kind: 'avoid_shift_type',
      shiftTypeId: NIGHT_12.id,
      weight: 5,
    },
  ];
  const input = solveInputFrom({
    startDate: isoDate(PERIOD_START),
    endDate: isoDate(PERIOD_END),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: DATES.flatMap((date) => [
      coverage(DAY_12, 'RN', 1, 1, null, isoDate(date)),
      coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(date)),
    ]),
    assignments: locked,
    preferences,
  });
  const model = new SolverModel(input);
  const x = model.nurseIdx.get('nurse-x')!;
  const y = model.nurseIdx.get('nurse-y')!;
  const z = model.nurseIdx.get('nurse-z')!;
  const lockedKeys = new Set(locked.map((a) => `${a.nurseId}|${a.date}|${a.shiftTypeId}`));
  // Built through the same pre-filter and gate as any solver move, so the starting point is a
  // state the annealer could genuinely be sitting in.
  for (let d = MON; d <= WED; d++) {
    for (const [n, st] of [
      [x, DAY_12],
      [y, NIGHT_12],
    ] as const) {
      const shift = model.shiftAt(d, st);
      if (lockedKeys.has(`${model.nurses[n]!.id}|${shift.date}|${st.id}`)) continue;
      const a = model.make(n, shift);
      if (!model.eligible(n, shift, null) || !model.canAdd(n, a))
        throw new Error(`setup: ${model.nurses[n]!.id} cannot take ${shift.date}`);
      model.add(a);
    }
  }
  return { model, x, y, z };
}

function codes(model: SolverModel, n: number): string[] {
  return model
    .timeline(n)
    .map((a) => `${a.date} ${a.shiftTypeId === DAY_12.id ? 'D' : 'N'}`)
    .sort();
}

describe('block moves', () => {
  it('finds no legal one-day trade between the day nurse and the night nurse', () => {
    const { model, x, y } = trapped();
    for (let d = MON; d <= WED; d++) {
      expect(exchangeBlock(model, x, y, d, d, 'swap')).toBeNull();
    }
    // And a refused trade leaves both timelines exactly as they were.
    expect(codes(model, x)).toEqual(['2026-01-05 D', '2026-01-06 D', '2026-01-07 D']);
    expect(codes(model, y)).toEqual(['2026-01-05 N', '2026-01-06 N', '2026-01-07 N']);
  });

  it('lets the two nurses trade their whole three-day blocks so each gets what they asked for', () => {
    const { model, x, y } = trapped();
    expect(model.breakdown().preferences).toBeGreaterThan(0);

    const move = exchangeBlock(model, x, y, MON, WED, 'swap');

    expect(move).not.toBeNull();
    expect(move!.delta).toBeLessThan(0);
    expect(codes(model, x)).toEqual(['2026-01-05 N', '2026-01-06 N', '2026-01-07 N']);
    expect(codes(model, y)).toEqual(['2026-01-05 D', '2026-01-06 D', '2026-01-07 D']);
    expect(model.breakdown().preferences).toBe(0);
    expect(model.hardShortfall()).toBe(0);
  });

  it('puts both nurses back exactly as they were when the trade is undone', () => {
    const { model, x, y } = trapped();
    const before = model.objective();
    const move = exchangeBlock(model, x, y, MON, WED, 'swap');
    move!.undo();
    expect(model.objective()).toBeCloseTo(before, 9);
    expect(codes(model, x)).toEqual(['2026-01-05 D', '2026-01-06 D', '2026-01-07 D']);
    expect(codes(model, y)).toEqual(['2026-01-05 N', '2026-01-06 N', '2026-01-07 N']);
  });

  it('never moves a shift the manager locked, even when it sits inside the block', () => {
    const pinned = assign('nurse-x', DAY_12, '2026-01-06', { id: 'pinned', isLocked: true });
    const { model, x, y } = trapped([pinned]);
    const before = model.objective();

    // With Tuesday's day pinned to X, the three-day trade would leave X on two nights either side
    // of a pinned day — illegal on rest — so the whole trade is refused rather than half-applied.
    expect(exchangeBlock(model, x, y, MON, WED, 'swap')).toBeNull();
    expect(model.timeline(x).some((a) => a.id === 'pinned' && a.isLocked)).toBe(true);
    expect(model.objective()).toBeCloseTo(before, 9);
  });

  it('hands a whole block of shifts to a colleague who is free', () => {
    const { model, x, z } = trapped();
    const move = exchangeBlock(model, x, z, MON, WED, 'give');
    expect(move).not.toBeNull();
    expect(codes(model, x)).toEqual([]);
    expect(codes(model, z)).toEqual(['2026-01-05 D', '2026-01-06 D', '2026-01-07 D']);
    move!.undo();
    expect(codes(model, x)).toEqual(['2026-01-05 D', '2026-01-06 D', '2026-01-07 D']);
    expect(codes(model, z)).toEqual([]);
  });
});

describe('a move that takes a shift away', () => {
  /**
   * The consecutive-nights limit only counts stretches made *entirely* of nights, so taking a
   * shift away can create a violation: day Mon + nights Tue–Fri is a legal five-day stretch, but
   * without Monday's day it is four nights in a row, against a limit of three. Found by the
   * release pipeline: SA + LNS emitted exactly that for a demo nurse.
   */
  function dayThenFourNights() {
    const nurseX = makeNurse({ id: 'nurse-x', firstName: 'Xena' });
    const nurseZ = makeNurse({ id: 'nurse-z', firstName: 'Zara' });
    const base = defaultRuleSet(UNIT_ID);
    // Five 12s in a week is 60h: lift the weekly cap so only the night rule is in play.
    const ruleSet = {
      ...base,
      configs: base.configs.map((c) =>
        c.ruleId === 'max-hours-per-week'
          ? { ...c, params: { ...c.params, maxHoursPerWeek: 84, overtimeThresholdHours: 84 } }
          : c,
      ),
    };
    const input = solveInputFrom({
      startDate: isoDate(PERIOD_START),
      endDate: isoDate(PERIOD_END),
      nurses: [nurseX, nurseZ],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        ...['2026-01-05'].map((d) => coverage(DAY_12, 'RN', 1, 1, null, isoDate(d))),
        ...['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map((d) =>
          coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(d)),
        ),
      ],
      ruleSet,
    });
    const model = new SolverModel(input);
    const x = model.nurseIdx.get('nurse-x')!;
    const z = model.nurseIdx.get('nurse-z')!;
    const pattern: [number, typeof DAY_12][] = [
      [MON, DAY_12],
      [MON + 1, NIGHT_12],
      [MON + 2, NIGHT_12],
      [MON + 3, NIGHT_12],
      [MON + 4, NIGHT_12],
    ];
    for (const [d, st] of pattern) {
      const a = model.make(x, model.shiftAt(d, st));
      if (!model.canAdd(x, a)) throw new Error(`setup: Xena cannot take ${st.name} on day ${d}`);
      model.add(a);
    }
    return { model, x, z };
  }

  it('knows a nurse left with four nights in a row is no longer legal', () => {
    const { model, x } = dayThenFourNights();
    expect(model.isLegal(x)).toBe(true);
    const monday = model.timeline(x).find((a) => a.shiftTypeId === DAY_12.id)!;
    model.remove(monday);
    expect(model.isLegal(x)).toBe(false);
  });

  it('refuses to hand away the day shift that keeps a run of nights legal', () => {
    const { model, x, z } = dayThenFourNights();
    const before = codes(model, x);
    expect(exchangeBlock(model, x, z, MON, MON, 'give')).toBeNull();
    expect(codes(model, x)).toEqual(before);
    expect(codes(model, z)).toEqual([]);
  });
});

describe('the annealer, when giving a shift away looks like an improvement', () => {
  it('keeps the day shift that keeps a run of nights legal', () => {
    // Xena holds day Mon + nights Tue–Fri and has asked to avoid days; Yusuf is on leave Tue–Fri,
    // so all he can take is Monday's day. Handing it to him scores better and leaves Xena with
    // four nights in a row — illegal. The annealer must not take that trade, however many times
    // it is offered.
    // Both per-diem: no contracted-hours floor, so losing Monday costs Xena nothing but the
    // preference she gains — the trade is a pure improvement unless the gate stops it.
    const perDiem = { employmentType: 'per_diem' as const, contractedHoursPerPeriod: 0 };
    const xena = makeNurse({ id: 'nurse-x', firstName: 'Xena', ...perDiem });
    const yusuf = makeNurse({ id: 'nurse-y', firstName: 'Yusuf', ...perDiem });
    const base = defaultRuleSet(UNIT_ID);
    const ruleSet = {
      ...base,
      configs: base.configs.map((c) =>
        c.ruleId === 'max-hours-per-week'
          ? { ...c, params: { ...c.params, maxHoursPerWeek: 84, overtimeThresholdHours: 84 } }
          : c,
      ),
    };
    const nights = ['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    const input = solveInputFrom({
      startDate: isoDate(PERIOD_START),
      endDate: isoDate(PERIOD_END),
      nurses: [xena, yusuf],
      shiftTypes: [DAY_12, NIGHT_12],
      coverageRequirements: [
        coverage(DAY_12, 'RN', 1, 1, null, isoDate('2026-01-05')),
        ...nights.map((d) => coverage(NIGHT_12, 'RN', 1, 1, null, isoDate(d))),
      ],
      preferences: [
        {
          id: 'p-x',
          nurseId: 'nurse-x',
          kind: 'avoid_shift_type',
          shiftTypeId: DAY_12.id,
          weight: 5,
        },
      ],
      timeOff: [timeOff('nurse-y', '2026-01-06', '2026-01-09')],
      ruleSet,
    });
    for (let seed = 1; seed <= 10; seed++) {
      const model = new SolverModel(input);
      const x = model.nurseIdx.get('nurse-x')!;
      for (const [d, st] of [
        [MON, DAY_12],
        [MON + 1, NIGHT_12],
        [MON + 2, NIGHT_12],
        [MON + 3, NIGHT_12],
        [MON + 4, NIGHT_12],
      ] as const) {
        const a = model.make(x, model.shiftAt(d, st));
        if (!model.canAdd(x, a)) throw new Error('setup: Xena cannot take her starting pattern');
        model.add(a);
      }
      anneal(model, new Rng(seed), { seed, maxIterations: 3000 }, { shouldStop: () => null });
      // Judged independently of the solver's own gate: the rule engine over the final schedule.
      const view = new ScheduleView({
        period: input.period,
        assignments: model.assignments(),
        nurses: model.nurses,
        shiftTypes: model.shiftTypes,
      });
      const broken = evaluateSchedule(view, input.ruleSet, model.ctx, {
        only: hardRuleIdsByScope(input.ruleSet, 'nurse'),
      }).hardViolations.filter((v) => v.code !== 'under_contracted_hours');
      expect(
        broken.map((v) => v.message),
        `seed ${seed}`,
      ).toEqual([]);
    }
  });
});
