/**
 * The hybrid's pure half, without a runner: CP-SAT's answer is played by hand-built value
 * vectors. What must hold whatever CP-SAT says: nothing outside the window moves, a worse or
 * illegal answer leaves the schedule exactly as it was, and windows are drawn reproducibly and
 * mostly where the schedule is short.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { defaultRuleSet, evaluateSchedule, hardRuleIdsByScope } from '../rules/registry.js';
import { ScheduleView } from '../schedule/view.js';
import {
  coverageAllWeek,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  timeOff,
  UNIT_ID,
} from '../testing/fixtures.js';
import { EncodingDisagreementError } from './cpsat/decode.js';
import { LocalSearch, type WindowJob } from './hybrid.js';
import type { SolveInput } from './types.js';

beforeEach(() => resetFixtureCounters());

function unit(extra: Partial<Parameters<typeof solveInputFrom>[0]> = {}, size = 6): SolveInput {
  resetFixtureCounters();
  const nurses = Array.from({ length: size }, (_, i) =>
    makeNurse({ isChargeEligible: i % 2 === 0 }),
  );
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 2),
      ...coverageAllWeek(NIGHT_12, 'RN', 1),
    ],
    ...extra,
  });
}

const OPTIONS = { seed: 3, maxIterations: 3000 };
const noStop = { shouldStop: () => null };
const key = (a: Assignment) => `${a.nurseId}|${a.date}|${a.shiftTypeId}`;

function searched(input = unit()): LocalSearch {
  const search = new LocalSearch(input, OPTIONS);
  search.seed();
  search.anneal(0, OPTIONS.maxIterations, noStop);
  return search;
}

/** The window's current schedule as an answer: every variable at its hinted value. */
function currentAnswer(job: WindowJob): number[] {
  const values = new Array<number>(job.encoding.builder.variableCount).fill(0);
  const hint = job.model.solution_hint!;
  for (const [i, v] of hint.vars.entries()) values[v] = hint.values[i]!;
  return values;
}

function outside(search: LocalSearch, job: WindowJob): string[] {
  const days = new Set(job.window.dates);
  return search.model
    .assignments()
    .filter((a) => !days.has(a.date))
    .map(key)
    .sort();
}

describe('the hybrid local search', () => {
  it('re-applies the window as it stands without changing anything or anything outside it', () => {
    const search = searched();
    const job = search.encodeWindow(search.pickWindow(3), 1);
    const before = search.model.assignments().map(key).sort();
    const objective = search.model.objective();
    const outcome = search.applyWindow(job, currentAnswer(job));
    expect(outcome.improved).toBe(false);
    expect(outcome.delta).toBeCloseTo(0, 6);
    expect(search.model.assignments().map(key).sort()).toEqual(before);
    expect(search.model.objective()).toBeCloseTo(objective, 6);
  });

  it('rejects an answer that empties the window, leaving the schedule exactly as it was', () => {
    const search = searched();
    const job = search.encodeWindow(search.pickWindow(3), 1);
    const before = search.model.assignments().map(key).sort();
    const outsideBefore = outside(search, job);
    const objective = search.model.objective();
    const empty = new Array<number>(job.encoding.builder.variableCount).fill(0);
    const outcome = search.applyWindow(job, empty);
    expect(outcome.improved).toBe(false);
    expect(outcome.delta).toBeGreaterThan(0);
    expect(search.model.assignments().map(key).sort()).toEqual(before);
    expect(outside(search, job)).toEqual(outsideBefore);
    expect(search.model.objective()).toBeCloseTo(objective, 6);
  });

  it('refuses an answer that breaks the rest rule, and puts the window back', () => {
    const search = searched();
    const job = search.encodeWindow(search.pickWindow(3), 1);
    const before = search.model.assignments().map(key).sort();
    const objective = search.model.objective();
    const values = currentAnswer(job);
    // One nurse on a night then the next morning's day inside the window: 0 hours of rest.
    const [first, second] = job.window.dates;
    const nurseId = job.encoding.shiftVars[0]!.nurseId;
    for (const sv of job.encoding.shiftVars) {
      if (sv.nurseId !== nurseId) continue;
      const night = sv.shift.date === first && sv.shift.shiftType.id === NIGHT_12.id;
      const day = sv.shift.date === second && sv.shift.shiftType.id === DAY_12.id;
      values[sv.variable] = night || day ? 1 : 0;
    }
    expect(() => search.applyWindow(job, values)).toThrow(/breaks a hard rule/);
    let thrown: unknown;
    try {
      search.applyWindow(job, values);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EncodingDisagreementError);
    const error = thrown as EncodingDisagreementError;
    expect(error.nurseId).toBe(nurseId);
    expect(error.breaches[0]!.code).toBe('insufficient_rest');
    // The day shift CP-SAT placed the morning after the night is the date to look at.
    expect(error.message).toContain(second!);
    expect(search.model.assignments().map(key).sort()).toEqual(before);
    expect(search.model.objective()).toBeCloseTo(objective, 6);
  });

  it('judges a nurse who swapped one window shift for another on the roster she ends with', () => {
    const input = unit();
    const search = searched(input);
    const job = search.encodeWindow(search.pickWindow(3), 1);
    const values = currentAnswer(job);
    const [first] = job.window.dates;
    const { shiftVars } = job.encoding;
    const { model } = search;
    const before = model.assignments().map(key).sort();
    const objective = model.objective();
    // Judged by the rule engine directly, not by the gate under test: does this nurse's whole
    // timeline, with the shift traded, break any hard nurse rule (the contracted-hours floor
    // aside, which the gate never applies)?
    const hardNurseRules = hardRuleIdsByScope(input.ruleSet, 'nurse');
    const legalTimeline = (timeline: Assignment[]) =>
      evaluateSchedule(
        new ScheduleView({
          period: input.period,
          assignments: timeline,
          priorAssignments: [],
          nurses: input.nurses,
          shiftTypes: input.shiftTypes,
        }),
        input.ruleSet,
        model.ctx,
        { only: hardNurseRules },
      ).hardViolations.every((v) => v.code === 'under_contracted_hours');
    // The first nurse on day 1 of the window who could legally work the day's other shift type
    // instead: the answer takes her off one shift and puts her on the other.
    const swap = shiftVars
      .filter((sv) => sv.shift.date === first && values[sv.variable] === 1)
      .flatMap((from) => {
        const to = shiftVars.find(
          (sv) =>
            sv.n === from.n &&
            sv.shift.date === first &&
            sv.shift.shiftType.id !== from.shift.shiftType.id,
        );
        if (!to) return [];
        const timeline = model
          .timeline(from.n)
          .filter((a) => !(a.date === first && a.shiftTypeId === from.shift.shiftType.id))
          .concat({
            ...model.timeline(from.n)[0]!,
            id: 'traded',
            date: first!,
            shiftTypeId: to.shift.shiftType.id,
            isLocked: false,
            isCharge: false,
          });
        return legalTimeline(timeline) ? [{ from, to }] : [];
      })[0];
    expect(swap).toBeDefined();
    const { from, to } = swap!;
    const trial = [...values];
    trial[from.variable] = 0;
    trial[to.variable] = 1;
    const outcome = search.applyWindow(job, trial);
    const nurseId = from.nurseId;
    const swapped = before
      .filter((k) => k !== `${nurseId}|${first}|${from.shift.shiftType.id}`)
      .concat(`${nurseId}|${first}|${to.shift.shiftType.id}`)
      .sort();
    // Accepted unless it made the schedule worse, in which case it was put back exactly.
    if (outcome.delta > 1e-6) {
      expect(model.assignments().map(key).sort()).toEqual(before);
      expect(model.objective()).toBeCloseTo(objective, 6);
    } else {
      expect(model.assignments().map(key).sort()).toEqual(swapped);
      expect(model.objective()).toBeCloseTo(objective + outcome.delta, 6);
    }
  });

  it('takes a window whose shifts break a rule only when read one at a time', () => {
    // Long stretches owe 9 hours off after 8 straight; min-rest is off so back-to-back shifts
    // are allowed. Ada works Wed 7 Jan Day 8 (07–15), Evening 8 (15–23) and Night 8 (23–07):
    // one unbroken 24-hour stretch with nothing after it, which is legal. The evening sorts
    // last, so read row by row the night follows the day's 8 hours with only 8 off.
    const BRIDGE = { ...EVENING_8, id: 'st-bridge', sortOrder: 99 };
    const base = defaultRuleSet(UNIT_ID);
    const input = solveInputFrom({
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      nurses: [makeNurse({ id: 'ada', firstName: 'Ada', isChargeEligible: true })],
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
    const search = new LocalSearch(input, OPTIONS);
    const wednesday = isoDate('2026-01-07');
    const job = search.encodeWindow({ dateIdxs: [3], dates: [wednesday] }, 1);
    const values = new Array<number>(job.encoding.builder.variableCount).fill(0);
    for (const sv of job.encoding.shiftVars)
      if (sv.shift.date === wednesday) values[sv.variable] = 1;
    const outcome = search.applyWindow(job, values);
    // Three floors of one each filled where none were: the schedule can only get better.
    expect(outcome.improved).toBe(true);
    expect(search.model.assignments().map(key).sort()).toEqual(
      [
        `ada|${wednesday}|${BRIDGE.id}`,
        `ada|${wednesday}|${DAY_8.id}`,
        `ada|${wednesday}|${NIGHT_8.id}`,
      ].sort(),
    );
  });

  it('draws the same windows from the same seed', () => {
    const draw = () => {
      const search = searched();
      return Array.from({ length: 10 }, () => search.pickWindow(3).dates.join(','));
    };
    expect(draw()).toEqual(draw());
  });

  it('picks the understaffed days far more often than the rest', () => {
    // Ten nurses staff every day comfortably; with seven of them on leave Wed 14 – Thu 15,
    // those two days cannot be.
    const leave = Array.from({ length: 7 }, (_, i) =>
      timeOff(`nurse-${i + 1}`, '2026-01-14', '2026-01-15'),
    );
    const search = searched(unit({ timeOff: leave }, 10));
    const hits = Array.from({ length: 200 }, () => search.pickWindow(3).dates).filter((d) =>
      d.includes(isoDate('2026-01-14')),
    ).length;
    // A uniform draw would include Wed 14 in 3 of 12 possible starts: 25%.
    expect(hits / 200).toBeGreaterThan(0.6);
  });
});
