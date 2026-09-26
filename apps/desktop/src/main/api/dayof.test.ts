/**
 * Backfilling a call-off from the Today screen. The replacement is re-ranked in main right before
 * the write, so a nurse who is not eligible is refused whatever the screen showed, and on a
 * published schedule the swap of rows goes into the change log as a backfill — the record staff
 * see of who covered whom.
 */

import { addDays } from '@shiftnurse/core';
import { listAssignmentsForPeriod, listChanges, publishSchedule } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { dayOfApi } from './dayof.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

describe('backfilling a call-off', () => {
  it('refuses a replacement who is already working that shift', () => {
    const grid = scheduleApi(f.handle.db);
    const date = addDays(f.seeded.draftStart, 4);
    const [ann, bea] = [f.rns[0]!, f.rns[1]!];
    const absent = grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date,
    });
    grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: bea.id,
      shiftTypeId: f.day.id,
      date,
    });

    const dayOf = dayOfApi(f.handle.db);
    const callOff = dayOf.reportCallOff(absent.id, 'sick');
    expect(() => dayOf.backfill(callOff.id, bea.id)).toThrow(/not eligible/);
    // Ann's shift is untouched: nothing was written.
    expect(
      listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).map((a) => a.id),
    ).toContain(absent.id);
  });

  it('writes the cover into a published schedule’s change log as a backfill', () => {
    const grid = scheduleApi(f.handle.db);
    const absent = grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 4),
    });
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);

    const dayOf = dayOfApi(f.handle.db);
    const callOff = dayOf.reportCallOff(absent.id, 'sick');
    const cover = dayOf.replacements(callOff.id).candidates[0];
    expect(cover).toBeDefined();
    const result = dayOf.backfill(callOff.id, cover!.nurseId);

    expect(result.callOff.status).toBe('covered');
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes.map((c) => [c.kind, c.source])).toEqual([
      ['added', 'backfill'],
      ['removed', 'backfill'],
    ]);
    expect(changes[1]!.nurseId).toBe(f.rns[0]!.id);
    expect(changes[0]!.reason).toMatch(/^Call-off: /);
  });
});
