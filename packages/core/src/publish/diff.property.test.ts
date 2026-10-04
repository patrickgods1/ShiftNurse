/**
 * Invariant: a republish diff is exact and keyed on who/date/shift, never on row ids.
 *
 * Why it matters: the diff is what gets told to staff and argued in a grievance. If applying it
 * to the old schedule did not give the new one, a nurse would be told of a change that is not
 * there or miss one that is; and a regenerate that only renumbers rows must read "no change".
 */

import { describe, expect, it } from 'vitest';
import type { Assignment } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import { Rng } from '../solver/rng.js';
import { assign, DAY_12, EVENING_8, NIGHT_12 } from '../testing/fixtures.js';
import { diffAssignments } from './diff.js';

const SEED = 4242;
const CASES = 200;
const NURSES = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
const SHIFTS = [DAY_12, NIGHT_12, EVENING_8];
const START = isoDate('2026-01-04');

/** A random schedule over 14 days: each (nurse, date, shift) key appears at most once. */
function randomSchedule(rng: Rng, idPrefix: string): Assignment[] {
  const out: Assignment[] = [];
  let n = 0;
  for (const nurse of NURSES) {
    for (let day = 0; day < 14; day++) {
      for (const st of SHIFTS) {
        if (!rng.chance(0.12)) continue;
        out.push(
          assign(nurse, st, addDays(START, day), {
            id: `${idPrefix}-${n++}`,
            isCharge: rng.chance(0.2),
            isOvertime: rng.chance(0.1),
            ...(rng.chance(0.1) ? { notes: 'swap' } : {}),
          }),
        );
      }
    }
  }
  return out;
}

const keyOf = (a: Assignment) => `${a.nurseId}::${a.date}::${a.shiftTypeId}`;

describe('the republish diff', () => {
  it('turns the published schedule into the edited one when its changes are applied', () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < CASES; i++) {
      const a = randomSchedule(rng, `a${i}`);
      const b = randomSchedule(rng, `b${i}`);
      const diff = diffAssignments(a, b);

      const applied = new Map(a.map((x) => [keyOf(x), x]));
      for (const c of diff.changes) {
        const k = `${c.nurseId}::${c.date}::${c.shiftTypeId}`;
        if (c.kind === 'removed') applied.delete(k);
        else applied.set(k, c.after as Assignment);
      }

      const msg = `seed ${SEED} case ${i}`;
      expect([...applied.keys()].sort(), msg).toEqual(b.map(keyOf).sort());
      expect(diff.added + diff.removed + diff.changed, msg).toBe(diff.changes.length);
    }
  });

  it('reports no change when a schedule is compared with itself', () => {
    const rng = new Rng(SEED + 1);
    for (let i = 0; i < CASES; i++) {
      const a = randomSchedule(rng, `a${i}`);
      const diff = diffAssignments(a, a);
      expect(diff.changes, `seed ${SEED + 1} case ${i}`).toEqual([]);
      expect(diff.affectedNurseIds).toEqual([]);
    }
  });

  it('reports no change when a regenerate lands the same shifts under new row ids', () => {
    const rng = new Rng(SEED + 2);
    for (let i = 0; i < CASES; i++) {
      const a = randomSchedule(rng, `a${i}`);
      // Locks and source are the manager's bookkeeping, so they may differ too.
      const regenerated = rng.shuffle(a).map((x, j) => ({
        ...x,
        id: `regen-${j}`,
        isLocked: rng.chance(0.5),
        source: 'solver' as const,
      }));
      const diff = diffAssignments(a, regenerated);
      expect(diff.changes, `seed ${SEED + 2} case ${i}`).toEqual([]);
    }
  });
});
