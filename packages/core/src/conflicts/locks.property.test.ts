/**
 * Invariant: a shift the manager has locked is never deleted or moved by a suggested
 * resolution, and never handed over by an exchange.
 *
 * Why it matters: a lock is the manager's promise ("Maria works this one, full stop"). A
 * resolution card that quietly takes it away, or an exchange that moves it, breaks that promise
 * in a place nobody is looking, and the solver, the grid and the exchange screen must all agree.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import { planExchange } from '../exchange/evaluate.js';
import { Rng } from '../solver/rng.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type ScenarioOptions,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { analyseConflicts } from './analyse.js';

const SEED = 31337;
const CASES = 100;
const START = isoDate('2026-01-04');
const END = isoDate('2026-01-17');
const SHIFTS = [DAY_12, NIGHT_12];

beforeEach(() => resetFixtureCounters());

function randomUnit(rng: Rng, approvedLeave: boolean): ScenarioOptions {
  const nurses: Nurse[] = [];
  const count = rng.nextInt(4, 7);
  for (let i = 0; i < count; i++) {
    nurses.push(makeNurse({ isChargeEligible: rng.chance(0.5) }));
  }
  const assignments: Assignment[] = [];
  let n = 0;
  for (const nurse of nurses) {
    for (let day = 0; day < 14; day++) {
      if (!rng.chance(0.4)) continue;
      assignments.push(
        assign(nurse.id, rng.pick(SHIFTS), addDays(START, day), {
          id: `row-${n++}`,
          isLocked: rng.chance(0.3),
          isCharge: nurse.isChargeEligible && rng.chance(0.3),
        }),
      );
    }
  }
  // Leave approved after the draft was built puts people on shifts they should not hold, which
  // is exactly when a resolution is tempted to delete a locked row.
  const leave = nurses
    .filter(() => rng.chance(0.4))
    .map((nurse) => {
      const from = rng.nextInt(0, 10);
      return timeOff(nurse.id, addDays(START, from), addDays(START, from + rng.nextInt(0, 3)), {
        status: approvedLeave && rng.chance(0.7) ? 'approved' : 'pending',
      });
    });
  return {
    startDate: START,
    endDate: END,
    nurses,
    shiftTypes: SHIFTS,
    assignments,
    timeOff: leave,
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', rng.nextInt(1, 3)),
      ...coverageAllWeek(NIGHT_12, 'RN', rng.nextInt(1, 2)),
    ],
  };
}

describe('the manager’s locks', () => {
  function lockedRowsTouched(approvedLeave: boolean, seed: number): string[] {
    const rng = new Rng(seed);
    const touched: string[] = [];
    let actionsSeen = 0;
    for (let i = 0; i < CASES; i++) {
      const opts = randomUnit(rng, approvedLeave);
      const locked = new Map(
        (opts.assignments ?? []).filter((a) => a.isLocked).map((a) => [a.id, a]),
      );
      // Approved leave outranks a lock (approval lifts locked draft shifts too), so the one
      // allowed touch is lifting a locked shift off the nurse whose approved leave covers it.
      const onApprovedLeave = (nurseId: string, date: string) =>
        (opts.timeOff ?? []).some(
          (r) =>
            r.nurseId === nurseId &&
            r.status === 'approved' &&
            r.startDate <= date &&
            date <= r.endDate,
        );
      const report = analyseConflicts(solveInputFrom(opts));
      for (const resolution of report.resolutions) {
        for (const action of resolution.actions) {
          actionsSeen++;
          if (action.type !== 'delete_assignment' && action.type !== 'move_assignment') continue;
          const row = locked.get(action.assignmentId);
          if (!row) continue;
          const liftForLeave =
            action.type === 'delete_assignment' && onApprovedLeave(row.nurseId, row.date);
          if (!liftForLeave) {
            touched.push(
              `seed ${seed} case ${i} ${resolution.kind} touches ${action.assignmentId}`,
            );
          }
        }
      }
    }
    expect(actionsSeen, `seed ${seed}: generator produced no resolutions`).toBeGreaterThan(0);
    return touched;
  }

  it('never appear in the deletes or moves of a suggested resolution', () => {
    expect(lockedRowsTouched(false, SEED)).toEqual([]);
  });

  it('only ever lift a locked shift off the nurse whose approved leave covers it', () => {
    expect(lockedRowsTouched(true, SEED)).toEqual([]);
  });

  it('are never handed to another nurse by an exchange', () => {
    const rng = new Rng(SEED + 1);
    let refused = 0;
    let planned = 0;
    for (let i = 0; i < CASES; i++) {
      const opts = randomUnit(rng, false);
      const rows = opts.assignments ?? [];
      const locked = new Set(rows.filter((a) => a.isLocked).map((a) => a.id));
      const offered = rng.pick(rows);
      const theirs = rows.filter((a) => a.nurseId !== offered.nurseId);
      if (theirs.length === 0) continue;
      const requested = rng.pick(theirs);
      const input = {
        ...solveInputFrom(opts),
        proposal: {
          kind: 'trade' as const,
          requestingNurseId: offered.nurseId,
          counterpartyNurseId: requested.nurseId,
          offeredAssignmentId: offered.id,
          requestedAssignmentId: requested.id,
        },
      };
      const msg = `seed ${SEED + 1} case ${i} offered ${offered.id} requested ${requested.id}`;
      if (locked.has(offered.id) || locked.has(requested.id)) {
        expect(() => planExchange(input), msg).toThrow(/locked/);
        refused++;
      } else {
        const plan = planExchange(input);
        expect(
          plan.remove.filter((id) => locked.has(id)),
          msg,
        ).toEqual([]);
        planned++;
      }
    }
    expect(refused, `seed ${SEED + 1}`).toBeGreaterThan(0);
    expect(planned, `seed ${SEED + 1}`).toBeGreaterThan(0);
  });
});
