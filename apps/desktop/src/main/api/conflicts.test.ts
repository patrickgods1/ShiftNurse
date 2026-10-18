/**
 * Approving a shift exchange re-judges it in main, from the stored swap, immediately before the
 * write — the renderer's verdict is never trusted. A swap that has become illegal since it was
 * proposed must be refused and left undecided, not half-applied.
 */

import { addDays } from '@shiftnurse/core';
import {
  applyResolution,
  auditHistoryFor,
  denySwap,
  getSwap,
  listAssignmentsForPeriod,
  proposeSwap,
  recentAudit,
  saveConflictPolicy,
  updateUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyse, approveExchange, autoResolve, resolveConflict } from './conflicts.js';
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

  it('says a swap was already decided, without its id', () => {
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
    // Denied rather than approved: a denial runs no rule check, so the outcome cannot depend on
    // what earlier tests left in the roster.
    denySwap(f.handle.db, swap.id, ACTOR, 'Coverage is too thin that day');

    const again = () => approveExchange(f.handle.db, swap.id, 'Bea agreed by phone');
    expect(again).toThrow('This shift swap is already denied; there is nothing to decide.');
    expect(again).not.toThrow(swap.id);
  });
});

describe('applying one resolution', () => {
  const auditCount = () => recentAudit(f.handle.db, 100_000).length;

  it('refuses a card that went stale after the nurse was put on the night before, and writes nothing', () => {
    const draft = f.seeded.draftPeriodId;
    const cutoff = addDays(f.seeded.draftStart, 1);
    const res = analyse(f.handle.db, draft).resolutions.find((r) => {
      const a = r.actions[0];
      return (
        r.actions.length === 1 &&
        a?.type === 'create_assignment' &&
        a.shiftTypeId === f.day.id &&
        a.date > cutoff
      );
    });
    expect(res).toBeDefined();
    const action = res!.actions[0]!;
    if (action.type !== 'create_assignment') throw new Error('unreachable');
    // Night 19:00-07:00 then Day 07:00 leaves 0 h of rest, so a fresh analysis cannot offer this.
    scheduleApi(f.handle.db).createAssignment({
      periodId: draft,
      nurseId: action.nurseId,
      shiftTypeId: f.night.id,
      date: addDays(action.date, -1),
    });
    const before = auditCount();

    expect(() => resolveConflict(f.handle.db, draft, res!.id, 'Fill the gap')).toThrow(
      /no longer applies/,
    );
    expect(
      listAssignmentsForPeriod(f.handle.db, draft).filter(
        (a) => a.nurseId === action.nurseId && a.date === action.date && a.shiftTypeId === f.day.id,
      ),
    ).toEqual([]);
    expect(auditCount()).toBe(before);
  }, 300_000);

  it('refuses an option the analysis never offered', () => {
    const before = auditCount();
    expect(() =>
      resolveConflict(f.handle.db, f.seeded.draftPeriodId, 'res-made-up', 'because'),
    ).toThrow(/no longer applies/);
    expect(auditCount()).toBe(before);
  }, 300_000);

  it('applies the option as the analysis offers it now, and audits main’s own figures', () => {
    const draft = f.seeded.draftPeriodId;
    const res = analyse(f.handle.db, draft).resolutions.find(
      (r) => r.actions.length === 1 && r.actions[0]?.type === 'create_assignment',
    )!;
    expect(res).toBeDefined();
    const applied = resolveConflict(f.handle.db, draft, res.id, 'Covers the short day');
    expect(applied.id).toBe(res.id);
    const action = res.actions[0]!;
    if (action.type !== 'create_assignment') throw new Error('unreachable');
    const created = listAssignmentsForPeriod(f.handle.db, draft).find(
      (a) =>
        a.nurseId === action.nurseId &&
        a.date === action.date &&
        a.shiftTypeId === action.shiftTypeId,
    );
    expect(created?.source).toBe('resolution');
    expect(auditHistoryFor(f.handle.db, 'conflict', res.conflictId)[0]).toMatchObject({
      action: 'resolve',
      reason: 'Covers the short day',
      after: { impact: res.impact },
    });
  }, 300_000);
});

describe('auto-resolve on a busy period', () => {
  it('keeps the record of the fixes already made when a later one is refused', () => {
    saveConflictPolicy(
      f.handle.db,
      f.seeded.unitId,
      { enabled: true, maxCostDelta: 1_000_000, maxFairnessDrop: 100 },
      ACTOR,
    );
    let calls = 0;
    const result = autoResolve(f.handle.db, f.seeded.draftPeriodId, (tx, ...rest) => {
      calls += 1;
      if (calls === 2) throw new Error('That nurse already has that shift on that day.');
      return applyResolution(tx, ...rest);
    });
    expect(result.applied).toHaveLength(1);
    expect(result.stoppedAt?.message).toBe('That nurse already has that shift on that day.');
    expect(result.stoppedAt?.resolution.id).not.toBe(result.applied[0]!.id);
    expect(result.report.conflicts.some((c) => c.id === result.applied[0]!.conflictId)).toBe(false);
  }, 300_000);

  it('fills what a generous policy allows, then finds nothing left to do', () => {
    saveConflictPolicy(
      f.handle.db,
      f.seeded.unitId,
      { enabled: true, maxCostDelta: 1_000_000, maxFairnessDrop: 100 },
      ACTOR,
    );
    const hardCount = () =>
      scheduleApi(f.handle.db).validate(f.seeded.draftPeriodId).result.hardViolations.length;
    const hardBefore = hardCount();
    const started = performance.now();
    const first = autoResolve(f.handle.db, f.seeded.draftPeriodId);
    const ms = performance.now() - started;
    expect(first.applied.length).toBeGreaterThan(1);
    // Judged by outcome: each fix closed the conflict it was offered for, only fixes that put
    // coverage right were used (never accepting a shortfall or denying leave), and the grid
    // has no more hard breaks than before.
    for (const fix of first.applied) {
      expect(first.report.conflicts.some((c) => c.id === fix.conflictId)).toBe(false);
      expect([
        'assign_available',
        'authorize_overtime',
        'move_assignment',
        'remove_assignment',
      ]).toContain(fix.kind);
    }
    expect(hardCount()).toBeLessThanOrEqual(hardBefore);
    // Every fix the first pass applied is in its last report, so a second pass has nothing
    // left to take.
    const second = autoResolve(f.handle.db, f.seeded.draftPeriodId);
    expect(second.applied).toEqual([]);
    console.info(`[auto-resolve] ${first.applied.length} fixes in ${Math.round(ms)} ms`);
  }, 300_000);
});

describe('applying a resolution on a unit that requires consent', () => {
  it("applies fixes to a draft without asking for the nurse's consent", () => {
    updateUnit(f.handle.db, f.seeded.unitId, { requireConsentForPostedChanges: true }, ACTOR);
    saveConflictPolicy(
      f.handle.db,
      f.seeded.unitId,
      { enabled: true, maxCostDelta: 1_000_000, maxFairnessDrop: 100 },
      ACTOR,
    );
    expect(autoResolve(f.handle.db, f.seeded.draftPeriodId).applied.length).toBeGreaterThan(0);
  }, 300_000);
});
