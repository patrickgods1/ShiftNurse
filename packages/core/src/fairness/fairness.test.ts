/**
 * End-to-end fairness properties: from real assignments on a `ScheduleView`, through
 * `deriveCounters`, into `scoreFairness`.
 *
 * The unit tests beside each module check hand-computed numbers. This file checks the one
 * invariant the whole pipeline must hold regardless of numbers: handing a nurse one more
 * undesirable shift can never make their fairness score go *up*. If it could, the solver
 * would learn to "improve" fairness by piling burden onto whoever is already carrying most.
 */

import { describe, expect, it } from 'vitest';
import type { Assignment, Holiday, Nurse, Preference, ShiftType } from '../domain/entities.js';
import { addDays, DEFAULT_WEEKEND, isoDate, weekdayOf } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  UNIT_ID,
} from '../testing/fixtures.js';
import { deriveCounters } from './ledger.js';
import { scoreFairness } from './score.js';
import type { CounterContext } from './types.js';

/** Tiny deterministic LCG so a failing case can be reproduced from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const START = isoDate('2026-01-04');
const END = isoDate('2026-01-31');
const HOLIDAY: Holiday = {
  id: 'h-1',
  unitId: UNIT_ID,
  date: isoDate('2026-01-19'),
  name: 'MLK Day',
  isMajor: true,
};

interface Roster {
  nurses: Nurse[];
  assignments: Assignment[];
  preferences: Preference[];
}

function randomRoster(seed: number): Roster {
  const next = rng(seed);
  resetFixtureCounters();
  const nurses: Nurse[] = [];
  const count = 4 + Math.floor(next() * 6);
  for (let i = 0; i < count; i++) {
    const fte = next() < 0.3 ? 0.5 : 1;
    nurses.push(
      makeNurse({
        fte,
        contractedHoursPerPeriod: fte * 72,
        seniorityDate: addDays(isoDate('2010-01-01'), Math.floor(next() * 5000)),
      }),
    );
  }

  const assignments: Assignment[] = [];
  const preferences: Preference[] = [];
  let prefId = 0;
  for (const nurse of nurses) {
    // Avoid-only preferences: a "prefer nights" nurse who is handed a night is legitimately
    // better off, so that case is excluded from the property rather than asserted against.
    if (next() < 0.5) {
      preferences.push({
        id: `p-${++prefId}`,
        nurseId: nurse.id,
        kind: 'avoid_shift_type',
        shiftTypeId: NIGHT_12.id,
        weight: 1 + Math.floor(next() * 5),
      });
    }
    if (next() < 0.3) {
      preferences.push({
        id: `p-${++prefId}`,
        nurseId: nurse.id,
        kind: 'avoid_weekday',
        weekday: 1,
        weight: 1 + Math.floor(next() * 5),
      });
    }
    let date = START;
    while (date <= END) {
      const roll = next();
      if (roll < 0.35) {
        const type: ShiftType = roll < 0.12 ? NIGHT_12 : roll < 0.15 ? ON_CALL : DAY_12;
        assignments.push(assign(nurse.id, type, date));
      }
      date = addDays(date, 1);
    }
  }
  return { nurses, assignments, preferences };
}

function scoreOf(roster: Roster, nurseId: string): number {
  const s = scenario({
    startDate: START,
    endDate: END,
    nurses: roster.nurses,
    assignments: roster.assignments,
    holidays: [HOLIDAY],
  });
  const ctx: CounterContext = {
    unit: s.unit,
    holidayDates: new Set([HOLIDAY.date]),
    weekendDefinition: DEFAULT_WEEKEND,
    preferences: roster.preferences,
  };
  const report = scoreFairness({
    nurses: roster.nurses,
    current: deriveCounters(s.schedule, ctx),
    history: [],
    preferences: roster.preferences,
  });
  const mine = report.scores.find((x) => x.nurseId === nurseId);
  if (!mine) throw new Error(`no score for ${nurseId}`);
  return mine.score;
}

/** A date in the period where the nurse has nothing on the day itself or either neighbour. */
function freeDate(roster: Roster, nurseId: string, want: (d: string) => boolean): string | null {
  const busy = new Set(
    roster.assignments.filter((a) => a.nurseId === nurseId).map((a) => a.date as string),
  );
  let date = addDays(START, 1);
  while (date < END) {
    if (
      want(date) &&
      !busy.has(addDays(date, -1)) &&
      !busy.has(date) &&
      !busy.has(addDays(date, 1))
    ) {
      return date;
    }
    date = addDays(date, 1);
  }
  return null;
}

interface Burden {
  name: string;
  type: ShiftType;
  where: (d: string) => boolean;
  /** Only meaningful for nurses with this preference (e.g. a Monday is a burden if you avoid Mondays). */
  requires?: Preference['kind'];
}

const BURDENS: Burden[] = [
  { name: 'a weekday night', type: NIGHT_12, where: (d) => weekdayOf(isoDate(d)) === 3 },
  { name: 'a Saturday day shift', type: DAY_12, where: (d) => weekdayOf(isoDate(d)) === 6 },
  { name: 'the holiday day shift', type: DAY_12, where: (d) => d === HOLIDAY.date },
  { name: 'an on-call', type: ON_CALL, where: (d) => weekdayOf(isoDate(d)) === 2 },
  {
    name: 'a Monday day shift',
    type: DAY_12,
    where: (d) => weekdayOf(isoDate(d)) === 1,
    requires: 'avoid_weekday',
  },
];

/**
 * A shift is only unambiguously "worse" if it honours none of the nurse's preferences. For a
 * nurse who asked to avoid nights, an extra *day* shift raises the share of their shifts that
 * are not nights — their preference was honoured one more time — even while it adds a weekend
 * or a holiday. That trade-off is real and the composite may go either way, so such pairs are
 * excluded rather than asserted against.
 */
function isPureBurden(roster: Roster, nurseId: string, burden: Burden): boolean {
  const prefs = roster.preferences.filter((p) => p.nurseId === nurseId);
  if (burden.requires !== undefined && !prefs.some((p) => p.kind === burden.requires)) return false;
  return !prefs.some((p) => p.kind === 'avoid_shift_type' && p.shiftTypeId !== burden.type.id);
}

describe('fairness monotonicity, end to end', () => {
  it('never raises a nurse’s score by giving them one more undesirable shift', () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const roster = randomRoster(seed);
      for (const burden of BURDENS) {
        for (const nurse of roster.nurses) {
          if (!isPureBurden(roster, nurse.id, burden)) continue;
          const date = freeDate(roster, nurse.id, burden.where);
          if (date === null) continue;
          const before = scoreOf(roster, nurse.id);
          const worse: Roster = {
            ...roster,
            assignments: [...roster.assignments, assign(nurse.id, burden.type, date)],
          };
          const after = scoreOf(worse, nurse.id);
          expect(
            after,
            `seed ${seed}: ${burden.name} on ${date} raised ${nurse.id} from ${before} to ${after}`,
          ).toBeLessThanOrEqual(before + 1e-9);
          checked++;
        }
      }
    }
    // Guard against the property silently checking nothing if the generator changes.
    expect(checked).toBeGreaterThan(200);
  });

  it('lowers the score of the nurse who took the extra holiday, not their colleagues’', () => {
    // First seed where the first nurse is free on the holiday and has no avoid-type preference
    // (see isPureBurden); found by search so the test does not depend on generator details.
    let roster = randomRoster(1);
    let date: string | null = null;
    for (let seed = 1; date === null && seed < 100; seed++) {
      roster = randomRoster(seed);
      const first = roster.nurses[0]!;
      if (roster.preferences.some((p) => p.nurseId === first.id && p.kind === 'avoid_shift_type')) {
        continue;
      }
      date = freeDate(roster, first.id, (d) => d === HOLIDAY.date);
    }
    if (date === null)
      throw new Error('no seed under 100 leaves the first nurse free on the holiday');
    const taker = roster.nurses[0]!;
    const before = roster.nurses.map((n) => scoreOf(roster, n.id));
    const worse: Roster = {
      ...roster,
      assignments: [...roster.assignments, assign(taker.id, DAY_12, date)],
    };
    const after = roster.nurses.map((n) => scoreOf(worse, n.id));
    expect(after[0]!).toBeLessThan(before[0]!);
    for (let i = 1; i < roster.nurses.length; i++) {
      expect(after[i]!).toBeGreaterThanOrEqual(before[i]! - 1e-9);
    }
  });
});
