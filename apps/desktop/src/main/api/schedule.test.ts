/**
 * The grid's edit policy as the renderer meets it through IPC: a published schedule changes
 * only with a reason, every change it takes is in the change log, and an archived one does not
 * change at all — including the lock toggle, which skips the change log on purpose.
 */

import { type Assignment, addDays } from '@shiftnurse/core';
import {
  createIncompatibilityGroup,
  listChanges,
  proposeSwap,
  publishSchedule,
  replaceNursePreferences,
  transact,
  updateIncompatibilityGroup,
  updatePeriodStatus,
  updateUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveExchange } from './conflicts.js';
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

describe('shifts that go against what a nurse asked for', () => {
  it('names the preference a night breaks for a nurse who avoids nights', () => {
    const nurse = f.rns[0]!;
    transact(f.handle.db, (tx) =>
      replaceNursePreferences(
        tx,
        nurse.id,
        [
          {
            id: 'pref-avoid-nights',
            nurseId: nurse.id,
            kind: 'avoid_shift_type',
            shiftTypeId: f.night.id,
            weight: 5,
          },
        ],
        ACTOR,
      ),
    );
    const night = api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: nurse.id,
      shiftTypeId: f.night.id,
      date: addDays(f.seeded.draftStart, 6),
    });
    const day = api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: nurse.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 9),
    });
    const validation = api.validate(f.seeded.draftPeriodId);
    expect(validation.againstPreference[night.id]?.map((p) => p.kind)).toEqual([
      'avoid_shift_type',
    ]);
    expect(validation.againstPreference[day.id]).toBeUndefined();
  });
});

describe('swapping two nurses’ shifts', () => {
  function placeAs(nurseIndex: number, dayOffset: number, shiftTypeId: string): Assignment {
    return api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[nurseIndex]!.id,
      shiftTypeId,
      date: addDays(f.seeded.draftStart, dayOffset),
    });
  }

  it('trades Ann’s day for Bea’s night on the same date in one step', () => {
    const ann = placeAs(0, 2, f.day.id);
    const bea = placeAs(1, 2, f.night.id);
    const [annNow, beaNow] = api.swapAssignments(ann.id, bea.id);
    expect([annNow.nurseId, annNow.shiftTypeId]).toEqual([f.rns[0]!.id, f.night.id]);
    expect([beaNow.nurseId, beaNow.shiftTypeId]).toEqual([f.rns[1]!.id, f.day.id]);
    const onDay = (nurseIndex: number) =>
      f.handle.db.query.assignment
        .findMany()
        .sync()
        .filter((a) => a.nurseId === f.rns[nurseIndex]!.id && a.date === ann.date)
        .map((a) => a.shiftTypeId);
    expect(onDay(0)).toEqual([f.night.id]);
    expect(onDay(1)).toEqual([f.day.id]);
  });

  it('leaves both shifts where they were when one of them is locked', () => {
    const ann = placeAs(0, 3, f.day.id);
    const bea = placeAs(1, 3, f.night.id);
    api.setLocked(bea.id, true);
    expect(() => api.swapAssignments(ann.id, bea.id)).toThrow(/locked/);
    const rows = f.handle.db.query.assignment.findMany().sync();
    expect(rows.find((a) => a.id === ann.id)?.nurseId).toBe(f.rns[0]!.id);
    expect(rows.find((a) => a.id === bea.id)?.nurseId).toBe(f.rns[1]!.id);
  });

  it('undoes the first half when the second cannot go through', () => {
    // Ann already works the night, so taking Bea's night would double-book her: the second
    // move fails after the first has run, and Ann must still have her day.
    const annDay = placeAs(0, 5, f.day.id);
    placeAs(0, 5, f.night.id);
    const beaNight = placeAs(1, 5, f.night.id);
    expect(() => api.swapAssignments(annDay.id, beaNight.id)).toThrow();
    const rows = f.handle.db.query.assignment.findMany().sync();
    expect(rows.find((a) => a.id === annDay.id)?.nurseId).toBe(f.rns[0]!.id);
    expect(rows.find((a) => a.id === beaNight.id)?.nurseId).toBe(f.rns[1]!.id);
  });

  it('logs a swap on a published schedule under its one reason', () => {
    const ann = placeAs(0, 4, f.day.id);
    const bea = placeAs(1, 4, f.night.id);
    publishDraft();
    expect(() => api.swapAssignments(ann.id, bea.id)).toThrow(/requires a reason/);
    api.swapAssignments(ann.id, bea.id, 'Bea asked to come off nights for her exam');
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes).toHaveLength(4);
    expect(changes.every((c) => c.reason === 'Bea asked to come off nights for her exam')).toBe(
      true,
    );
  });
});

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

describe('nurses kept apart, as the grid judges them', () => {
  it('flags two nurses of a group sharing a day shift, and not once the group has ended', () => {
    const group = transact(f.handle.db, (tx) =>
      createIncompatibilityGroup(
        tx,
        {
          unitId: f.seeded.unitId,
          name: 'Keep apart',
          nurseIds: [f.rns[0]!.id, f.rns[1]!.id],
          maxTogether: 1,
        },
        'test',
        ACTOR,
      ),
    );
    place(0, 1);
    place(1, 1);
    const together = () =>
      api
        .validate(f.seeded.draftPeriodId)
        .result.violations.filter((v) => v.code === 'incompatible_staff_together');
    expect(together()).toHaveLength(1);
    expect(together()[0]!.nurseIds.sort()).toEqual([f.rns[0]!.id, f.rns[1]!.id].sort());

    transact(f.handle.db, (tx) =>
      updateIncompatibilityGroup(
        tx,
        group.id,
        { endsOn: addDays(f.seeded.draftStart, 0) },
        'Resolved',
        ACTOR,
      ),
    );
    expect(together()).toEqual([]);
  });
});

describe("the nurse's consent to a posted change", () => {
  function requireConsent(on: boolean | null = true): void {
    updateUnit(f.handle.db, f.seeded.unitId, { requireConsentForPostedChanges: on }, ACTOR);
  }
  function move(shift: Assignment, consent?: string): Assignment {
    return api.moveAssignment(
      {
        assignmentId: shift.id,
        nurseId: f.rns[1]!.id,
        shiftTypeId: f.day.id,
        date: shift.date,
      },
      'Ann swapped with Bea at the charge desk',
      consent,
    );
  }

  it("refuses to move a posted shift without the nurse's consent when the unit requires it", () => {
    const shift = place(0, 1);
    publishDraft();
    requireConsent();
    expect(() => move(shift)).toThrow(/requires the nurse's consent/);
    expect(() => move(shift, '   ')).toThrow(/requires the nurse's consent/);
    expect(listChanges(f.handle.db, f.seeded.draftPeriodId)).toEqual([]);
  });

  it("refuses to add, change, remove or swap a posted shift without the nurse's consent", () => {
    const a = place(0, 1);
    const b = place(1, 1);
    publishDraft();
    requireConsent();
    const refused = /requires the nurse's consent/;
    expect(() => place(2, 2, 'Cover the gap')).toThrow(refused);
    expect(() => api.updateAssignment(a.id, { isCharge: true }, 'Ann takes charge')).toThrow(
      refused,
    );
    expect(() => api.deleteAssignment(a.id, 'Ann is not needed')).toThrow(refused);
    expect(() => api.swapAssignments(a.id, b.id, 'Trade them')).toThrow(refused);
    expect(listChanges(f.handle.db, f.seeded.draftPeriodId)).toEqual([]);
  });

  it('records the consent on the change log', () => {
    const shift = place(0, 1);
    publishDraft();
    requireConsent();
    move(shift, ' agreed by phone 6 Oct 14:10 ');
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.consent === 'agreed by phone 6 Oct 14:10')).toBe(true);
    const audits = f.handle.db.query.auditLog.findMany().sync();
    expect(
      audits.some((a) => a.entityType === 'schedule_change' && a.reason?.includes('6 Oct 14:10')),
    ).toBe(true);
  });

  it('needs no consent on a draft schedule', () => {
    requireConsent();
    const shift = place(0, 1);
    expect(() => move(shift)).not.toThrow();
  });

  it('needs no consent when the unit has not opted in', () => {
    const shift = place(0, 1);
    publishDraft();
    expect(() => move(shift)).not.toThrow();
  });

  it('does not ask consent for a trade the nurses proposed', () => {
    const shift = place(0, 1);
    publishDraft();
    requireConsent();
    const swap = proposeSwap(
      f.handle.db,
      {
        periodId: f.seeded.draftPeriodId,
        kind: 'giveaway',
        requestingNurseId: f.rns[0]!.id,
        counterpartyNurseId: f.rns[1]!.id,
        offeredAssignmentId: shift.id,
        reason: 'Bea offered to take it',
      },
      ACTOR,
    );
    // Which nurse holds the preceptor credential varies by seed, so a coverage block may stop
    // the trade; what matters here is that consent is never what stops it.
    expect(() => approveExchange(f.handle.db, swap.id, 'Both nurses agreed')).not.toThrow(
      /consent/,
    );
  });
});
