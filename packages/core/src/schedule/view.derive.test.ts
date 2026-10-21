/**
 * Invariant: a view derived from another (`ScheduleView.derive`) answers every question exactly
 * as a view built from scratch over the same rows would — the same rows, in the same order.
 *
 * Why it matters: the conflicts engine simulates hundreds of fixes on one period and derives
 * each from the baseline, sharing the lookback tail and every nurse the fix did not touch. Rules
 * walk timelines in order and break ties by position, so a derived view that held the right
 * rows in a different order would judge a turnaround or a tie differently, and a resolution
 * card would promise an outcome the grid then contradicts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse, SchedulePeriod } from '../domain/entities.js';
import { addDays, type IsoDate, isoDate } from '../domain/time.js';
import { Rng } from '../solver/rng.js';
import {
  assign,
  makeNurse,
  resetFixtureCounters,
  testShiftTypes,
  UNIT_ID,
} from '../testing/fixtures.js';
import { ScheduleView } from './view.js';

const SEED = 4417;
const CASES = 300;
const START = isoDate('2026-03-01'); // the week holding the spring-forward night
const DAYS = 7;
const ROLES = ['RN', 'RN', 'LPN', 'CNA'] as const;

const period: SchedulePeriod = {
  id: 'period-1',
  unitId: UNIT_ID,
  name: 'Derive test',
  startDate: START,
  endDate: addDays(START, DAYS - 1),
  status: 'draft',
  ruleSetId: 'ruleset-test',
  ruleSetVersion: 1,
};

beforeEach(() => resetFixtureCounters());

function randomRow(rng: Rng, nurses: readonly Nurse[], date: IsoDate): Assignment {
  return assign(rng.pick(nurses).id, rng.pick(testShiftTypes), date, {
    ...(rng.chance(0.1) ? { holdoverMinutes: rng.nextInt(1, 4) * 30 } : {}),
    ...(rng.chance(0.1) ? { floatedTo: '5 East' } : {}),
  });
}

function inPeriodDate(rng: Rng): IsoDate {
  return addDays(START, rng.nextInt(0, DAYS - 1));
}

/** A fix the engine might simulate: drop rows, add rows, swap one row for another, reorder. */
function mutate(rng: Rng, rows: readonly Assignment[], nurses: readonly Nurse[]): Assignment[] {
  let out = rows.slice();
  const steps = rng.nextInt(1, 3);
  for (let s = 0; s < steps; s++) {
    switch (rng.nextInt(0, 4)) {
      case 0:
        out = out.filter(() => rng.chance(0.8));
        break;
      case 1:
        for (let i = rng.nextInt(1, 4); i > 0; i--)
          out.push(randomRow(rng, nurses, inPeriodDate(rng)));
        break;
      case 2:
        if (out.length > 0) {
          const i = rng.nextInt(0, out.length - 1);
          const old = out[i]!;
          // Half the time the same nurse's row moves shift; otherwise it goes to someone else.
          out[i] = rng.chance()
            ? assign(old.nurseId, rng.pick(testShiftTypes), old.date)
            : randomRow(rng, nurses, old.date);
        }
        break;
      case 3:
        out = rng.shuffle(out);
        break;
      default:
        // Every row of one nurse gone: her timeline falls back to the lookback alone.
        if (out.length > 0) {
          const gone = rng.pick(out).nurseId;
          out = out.filter((a) => a.nurseId !== gone);
        }
    }
  }
  return out;
}

/** Every public question, keyed by what was asked, so a mismatch names the question. */
function answers(view: ScheduleView, nurses: readonly Nurse[], rows: readonly Assignment[]) {
  const out: Record<string, unknown> = {
    assignments: view.assignments(),
    assignmentsWithHistory: view.assignmentsWithHistory(),
    toAssignments: view.toAssignments(),
    dates: view.dates,
  };
  for (const a of rows) out[`get ${a.id}`] = view.get(a.id);
  out['get missing'] = view.get('no-such-row');
  for (const n of [...nurses, makeNurse({ id: 'nobody' })]) {
    out[`timelineFor ${n.id}`] = view.timelineFor(n.id);
    out[`assignmentsFor ${n.id}`] = view.assignmentsFor(n.id);
  }
  for (let d = -2; d < DAYS + 1; d++) {
    const date = addDays(START, d);
    out[`onDate ${date}`] = view.onDate(date);
    for (const n of nurses) out[`isAssignedOn ${n.id} ${date}`] = view.isAssignedOn(n.id, date);
    for (const st of testShiftTypes) {
      out[`onShift ${date} ${st.id}`] = view.onShift(date, st.id);
      out[`rosterAt ${date} ${st.id}`] = view.rosterAt(date, st.id);
      for (const role of ROLES) {
        out[`countOnShift ${date} ${st.id} ${role}`] = view.countOnShift(date, st.id, role);
      }
    }
  }
  return out;
}

describe('a simulated fix judged on a view derived from the baseline', () => {
  it('sees exactly the schedule a freshly built view sees, in the same order', () => {
    const rng = new Rng(SEED);
    for (let c = 0; c < CASES; c++) {
      const nurses = ROLES.map((role, i) => makeNurse({ id: `n${i}`, role }));
      // The tail: the nights and days before the period, plus busy time inside it, which shares
      // start minutes with in-period rows and so exercises the tie order.
      const prior = Array.from({ length: rng.nextInt(0, 8) }, () =>
        randomRow(rng, nurses, addDays(START, rng.nextInt(-3, DAYS - 1))),
      );
      const baseRows = Array.from({ length: rng.nextInt(0, 20) }, () =>
        randomRow(rng, nurses, inPeriodDate(rng)),
      );
      const input = { period, priorAssignments: prior, nurses, shiftTypes: testShiftTypes };
      let base = new ScheduleView({ ...input, assignments: baseRows });
      let rows: Assignment[] = baseRows;
      // A chain: the engine's candidates derive from the baseline, and a derived view can be
      // a base in turn.
      for (let step = 0; step < 3; step++) {
        rows = rng.chance(0.15) ? rows : mutate(rng, rows, nurses);
        const derived = ScheduleView.derive(base, rows);
        const fresh = new ScheduleView({ ...input, assignments: rows });
        const asked = [...prior, ...rows];
        expect(answers(derived, nurses, asked), `case ${c} step ${step}`).toStrictEqual(
          answers(fresh, nurses, asked),
        );
        base = derived;
      }
    }
  });

  it('refuses a row for a nurse who is not on the roster, as a fresh view does', () => {
    const nurse = makeNurse({ id: 'n0' });
    const rows = [assign('n0', testShiftTypes[0]!, START)];
    const base = new ScheduleView({
      period,
      assignments: rows,
      nurses: [nurse],
      shiftTypes: testShiftTypes,
    });
    const stray = assign('ghost', testShiftTypes[0]!, START, { id: 'stray' });
    expect(() => ScheduleView.derive(base, [...rows, stray])).toThrow(
      'Assignment stray references unknown nurse ghost',
    );
  });

  it('refuses a row on a shift the unit does not have, as a fresh view does', () => {
    const nurse = makeNurse({ id: 'n0' });
    const base = new ScheduleView({
      period,
      assignments: [],
      nurses: [nurse],
      shiftTypes: testShiftTypes,
    });
    const stray: Assignment = {
      ...assign('n0', testShiftTypes[0]!, START),
      id: 'stray',
      shiftTypeId: 'st-x',
    };
    expect(() => ScheduleView.derive(base, [stray])).toThrow(
      'Assignment stray references unknown shift type st-x',
    );
  });
});
