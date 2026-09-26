/**
 * The grid's edit policy as the renderer meets it through IPC: a published schedule changes
 * only with a reason, every change it takes is in the change log, and an archived one does not
 * change at all — including the lock toggle, which skips the change log on purpose.
 */

import { type Assignment, addDays } from '@shiftnurse/core';
import { listChanges, publishSchedule, updatePeriodStatus } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
let api: ReturnType<typeof scheduleApi>;

beforeEach(() => {
  f = openFixture();
  api = scheduleApi(f.handle.db);
});

afterEach(() => {
  f.handle.close();
});

function place(nurseIndex: number, dayOffset: number, reason?: string): Assignment {
  return api.createAssignment(
    {
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[nurseIndex]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, dayOffset),
    },
    reason,
  );
}

function publishDraft(): void {
  publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
}

describe('editing a schedule through the API', () => {
  it('lets a draft change freely and keeps no change log for it', () => {
    place(0, 1);
    expect(listChanges(f.handle.db, f.seeded.draftPeriodId)).toEqual([]);
  });

  it('refuses to change a published schedule without a reason', () => {
    publishDraft();
    expect(() => place(0, 1)).toThrow(/requires a reason/);
    expect(() => place(0, 1, '   ')).toThrow(/requires a reason/);
  });

  it('logs a move on a published schedule as a removal and an addition, under the reason', () => {
    const shift = place(0, 1);
    publishDraft();
    api.moveAssignment(
      {
        assignmentId: shift.id,
        nurseId: f.rns[1]!.id,
        shiftTypeId: f.day.id,
        date: shift.date,
      },
      'Ann swapped with Bea at the charge desk',
    );
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    // Newest first: the change log reads like a feed.
    expect(changes.map((c) => [c.kind, c.nurseId])).toEqual([
      ['added', f.rns[1]!.id],
      ['removed', f.rns[0]!.id],
    ]);
    expect(changes.every((c) => c.reason === 'Ann swapped with Bea at the charge desk')).toBe(true);
    expect(changes.every((c) => c.source === 'manual')).toBe(true);
  });

  it('freezes an archived schedule against every edit, locking included', () => {
    const shift = place(0, 1);
    updatePeriodStatus(f.handle.db, f.seeded.draftPeriodId, 'archived', ACTOR);
    expect(() => place(1, 2, 'late add')).toThrow(/archived/);
    expect(() => api.deleteAssignment(shift.id, 'tidy up')).toThrow(/archived/);
    expect(() => api.setLocked(shift.id, true)).toThrow(/archived/);
  });

  it('records a hand-placed shift as manual whatever source the payload claims', () => {
    const created = api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 3),
      // Not in the type; a payload can still carry it.
      ...({ source: 'solver' } as object),
    });
    expect(created.source).toBe('manual');
  });
});
