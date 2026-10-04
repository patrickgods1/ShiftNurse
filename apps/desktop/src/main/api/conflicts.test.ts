/**
 * Approving a shift exchange re-judges it in main, from the stored swap, immediately before the
 * write — the renderer's verdict is never trusted. A swap that has become illegal since it was
 * proposed must be refused and left undecided, not half-applied.
 */

import { addDays } from '@shiftnurse/core';
import { getSwap, proposeSwap, saveConflictPolicy } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveExchange, autoResolve } from './conflicts.js';
import { ACTOR } from './context.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

describe('approving a shift exchange', () => {
  it('refuses a giveaway that would double-book the nurse taking it, and leaves it undecided', () => {
    const api = scheduleApi(f.handle.db);
    const date = addDays(f.seeded.draftStart, 2);
    const [ann, bea] = [f.rns[0]!, f.rns[1]!];
    const annShift = api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date,
    });
    const swap = proposeSwap(
      f.handle.db,
      {
        periodId: f.seeded.draftPeriodId,
        kind: 'giveaway',
        requestingNurseId: ann.id,
        counterpartyNurseId: bea.id,
        offeredAssignmentId: annShift.id,
      },
      ACTOR,
    );
    // Proposed while Bea was free; she has since been put on the same day shift.
    api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: bea.id,
      shiftTypeId: f.day.id,
      date,
    });

    expect(() => approveExchange(f.handle.db, swap.id, 'Bea agreed by phone')).toThrow(
      /Exchange blocked/,
    );
    expect(getSwap(f.handle.db, swap.id)?.status).toBe('proposed');
  });
});

describe('auto-resolve on a busy period', () => {
  it('fills what a generous policy allows, then finds nothing left to do', () => {
    saveConflictPolicy(
      f.handle.db,
      f.seeded.unitId,
      { enabled: true, maxCostDelta: 1_000_000, maxFairnessDrop: 100 },
      ACTOR,
    );
    const started = performance.now();
    const first = autoResolve(f.handle.db, f.seeded.draftPeriodId);
    const ms = performance.now() - started;
    expect(first.applied.length).toBeGreaterThan(1);
    // Every fix the first pass applied is in its last report, so a second pass has nothing
    // left to take.
    const second = autoResolve(f.handle.db, f.seeded.draftPeriodId);
    expect(second.applied).toEqual([]);
    console.info(`[auto-resolve] ${first.applied.length} fixes in ${Math.round(ms)} ms`);
  }, 300_000);
});
