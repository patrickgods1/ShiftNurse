/**
 * The hybrid's pure half, without a runner: CP-SAT's answer is played by hand-built value
 * vectors. What must hold whatever CP-SAT says: nothing outside the window moves, a worse or
 * illegal answer leaves the schedule exactly as it was, and windows are drawn reproducibly and
 * mostly where the schedule is short.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
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
    expect(search.model.assignments().map(key).sort()).toEqual(before);
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
