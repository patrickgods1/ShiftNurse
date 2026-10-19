/**
 * The grid's edit policy as the renderer meets it through IPC: a published schedule changes
 * only with a reason, every change it takes is in the change log, and an archived one does not
 * change at all — including the lock toggle, which skips the change log on purpose.
 */

import { type Assignment, addDays, isoDate, weekdayOf } from '@shiftnurse/core';
import {
  archivePeriod,
  createAssignment,
  createAvailabilityBlock,
  createIncompatibilityGroup,
  createNurse,
  createNurseUnit,
  createPeriod,
  createUnit,
  getLatestRuleSet,
  getPeriod,
  listAssignmentsForPeriod,
  listChanges,
  listCredentials,
  listNurseCredentials,
  listPeriodsForUnit,
  proposeSwap,
  publishSchedule,
  recentAudit,
  replaceNursePreferences,
  saveRuleSet,
  transact,
  updateIncompatibilityGroup,
  updateNurse,
  updateUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveExchange } from './conflicts.js';
import { ACTOR } from './context.js';
import { rosterApi } from './roster.js';
import { periodsApi, scheduleApi } from './schedule.js';
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
  transact(f.handle.db, (tx) =>
    publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
  );
}

describe('a shift outside its schedule', () => {
  it('refuses a shift 200 days before the draft, and writes nothing', () => {
    const before = recentAudit(f.handle.db, 100000).length;
    expect(() =>
      api.createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: f.rns[0]!.id,
        shiftTypeId: f.day.id,
        date: addDays(f.seeded.draftStart, -200),
      }),
    ).toThrow(/is outside/);
    expect(recentAudit(f.handle.db, 100000)).toHaveLength(before);
  });
});

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
    expect(() => api.swapAssignments(annDay.id, beaNight.id)).toThrow(
      /UNIQUE constraint failed: assignment/,
    );
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
    publishDraft();
    archivePeriod(f.handle.db, f.seeded.draftPeriodId, ACTOR, 'Closed pay period');
    expect(() => place(1, 2, 'late add')).toThrow(/archived/);
    expect(() => api.deleteAssignment(shift.id, 'tidy up')).toThrow(/archived/);
    expect(() => api.setLocked(shift.id, true)).toThrow(/archived/);
  });

  it('corrects a shift on seeded history with a reason and logs it in the change log', () => {
    const history = listPeriodsForUnit(f.handle.db, f.seeded.unitId).find(
      (p) => p.status === 'published',
    )!;
    const a = listAssignmentsForPeriod(f.handle.db, history.id)[0]!;
    api.deleteAssignment(a.id, 'She swapped out by phone');
    const changes = listChanges(f.handle.db, history.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'removed',
      assignmentId: a.id,
      reason: 'She swapped out by phone',
    });
  });

  it('refuses a schedule that ends before it starts, and records nothing', () => {
    const periodsBefore = listPeriodsForUnit(f.handle.db, f.seeded.unitId).length;
    const auditBefore = recentAudit(f.handle.db, 1000).length;
    expect(() =>
      periodsApi(f.handle.db).create({
        unitId: f.seeded.unitId,
        name: 'Backwards',
        startDate: isoDate('2027-03-10'),
        endDate: isoDate('2027-03-01'),
      }),
    ).toThrow(/The period ends before it starts/);
    expect(listPeriodsForUnit(f.handle.db, f.seeded.unitId)).toHaveLength(periodsBefore);
    expect(recentAudit(f.handle.db, 1000)).toHaveLength(auditBefore);
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

describe('a draft laid over a published schedule of the same unit', () => {
  it('flags the turnaround against a shift on an overlapping published schedule', () => {
    const D = f.seeded.draftStart;
    const ana = f.rns[0]!;
    const draft = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
    const a = createPeriod(
      f.handle.db,
      {
        unitId: f.seeded.unitId,
        name: 'Overlapping',
        startDate: D,
        endDate: addDays(D, 13),
        ruleSetId: draft.ruleSetId,
        ruleSetVersion: draft.ruleSetVersion,
      },
      ACTOR,
    );
    createAssignment(
      f.handle.db,
      { periodId: a.id, nurseId: ana.id, shiftTypeId: f.day.id, date: addDays(D, 3) },
      ACTOR,
    );
    transact(f.handle.db, (tx) => publishSchedule(tx, { periodId: a.id }, ACTOR));
    const night = api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ana.id,
      shiftTypeId: f.night.id,
      date: addDays(D, 2),
    });
    // The night runs 19:00 on D+2 to 07:00 on D+3, and the posted day starts 07:00 on D+3: 0 h.
    const rest = api
      .validate(f.seeded.draftPeriodId)
      .result.hardViolations.filter((v) => v.code === 'insufficient_rest');
    expect(rest).toHaveLength(1);
    expect(rest[0]!.nurseIds).toEqual([ana.id]);
    expect(rest[0]!.assignmentIds).toContain(night.id);
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

describe('a nurse floated in from another unit, as the grid judges her', () => {
  it('keeps a floated nurse’s Sabbath off on the unit she floats to', () => {
    const { db } = f.handle;
    const draft = getPeriod(db, f.seeded.draftPeriodId)!;
    const west = createUnit(
      db,
      {
        name: '5 West',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const fran = createNurse(
      db,
      {
        unitId: west.id,
        employeeId: 'W-100',
        firstName: 'Fran',
        lastName: 'Float',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: false,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    );
    createNurseUnit(
      db,
      {
        nurseId: fran.id,
        unitId: f.seeded.unitId,
        startDate: draft.startDate,
        endDate: draft.endDate,
      },
      ACTOR,
    );
    // Recorded on her home unit, where accommodations live; it applies wherever she works.
    createAvailabilityBlock(
      db,
      {
        unitId: west.id,
        nurseId: fran.id,
        weekdays: [5],
        startTime: '18:00',
        endTime: '18:00',
        reason: 'Observes the Sabbath',
      },
      ACTOR,
    );
    let saturday = draft.startDate;
    while (weekdayOf(saturday) !== 6) saturday = addDays(saturday, 1);
    expect(f.day).toMatchObject({ startTime: '07:00', durationHours: 12 });
    api.createAssignment({
      periodId: draft.id,
      nurseId: fran.id,
      shiftTypeId: f.day.id,
      date: saturday,
    });
    // The block runs Fri 18:00 to Sat 18:00; the day shift runs Sat 07:00-19:00, 11 h inside it.
    const hits = api
      .validate(draft.id)
      .result.hardViolations.filter((v) => v.code === 'works_during_accommodation');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.nurseIds).toEqual([fran.id]);
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

  it('approves a trade the nurses proposed without asking their consent again', () => {
    // Two preceptors, so handing the day shift across cannot leave it short and coverage can
    // never be what stops the trade.
    const code = listCredentials(f.handle.db).find((c) => c.code === 'PRECEPTOR')!;
    const held = f.rns.filter((n) =>
      listNurseCredentials(f.handle.db, n.id).some((c) => c.credentialId === code.id),
    );
    expect(held.length, 'the scenario unit needs two preceptor RNs').toBeGreaterThanOrEqual(2);
    const [ann, bea] = [held[0]!, held[1]!];
    const shift = api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 1),
    });
    publishDraft();
    requireConsent();
    const swap = proposeSwap(
      f.handle.db,
      {
        periodId: f.seeded.draftPeriodId,
        kind: 'giveaway',
        requestingNurseId: ann.id,
        counterpartyNurseId: bea.id,
        offeredAssignmentId: shift.id,
        reason: 'Bea offered to take it',
      },
      ACTOR,
    );
    const approved = approveExchange(f.handle.db, swap.id, 'Both nurses agreed');
    expect(approved.status).toBe('approved');
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.consent === undefined)).toBe(true);
  });
});

describe('a nurse who has left', () => {
  const leave = (nurseIndex: number) =>
    transact(f.handle.db, (tx) => updateNurse(tx, f.rns[nurseIndex]!.id, { active: false }, ACTOR));
  const nurseOf = (id: string) =>
    f.handle.db.query.assignment
      .findMany()
      .sync()
      .find((a) => a.id === id)?.nurseId;

  it('will not put a new shift on a nurse who has left', () => {
    rosterApi(f.handle.db).nurses.deactivate(f.rns[0]!.id);
    const before = recentAudit(f.handle.db, 100000).length;
    expect(() => place(0, 1)).toThrow(/is inactive, so they cannot take new shifts/);
    expect(recentAudit(f.handle.db, 100000)).toHaveLength(before);
  });

  it('lets her shift be moved to a colleague, but not to another of her days', () => {
    const covered = place(0, 2);
    const other = place(0, 3);
    leave(0);
    const moved = api.moveAssignment({
      assignmentId: covered.id,
      nurseId: f.rns[1]!.id,
      shiftTypeId: covered.shiftTypeId,
      date: covered.date,
    });
    expect(moved.nurseId).toBe(f.rns[1]!.id);
    expect(() =>
      api.moveAssignment({
        assignmentId: other.id,
        nurseId: f.rns[0]!.id,
        shiftTypeId: other.shiftTypeId,
        date: addDays(other.date, 2),
      }),
    ).toThrow(/is inactive, so they cannot take new shifts/);
    expect(nurseOf(other.id)).toBe(f.rns[0]!.id);
  });

  it('will not swap a shift onto a nurse who has left', () => {
    const hers = place(0, 4);
    const theirs = api.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[1]!.id,
      shiftTypeId: f.night.id,
      date: hers.date,
    });
    leave(0);
    expect(() => api.swapAssignments(hers.id, theirs.id)).toThrow(
      /is inactive, so they cannot take new shifts/,
    );
    expect(nurseOf(hers.id)).toBe(f.rns[0]!.id);
    expect(nurseOf(theirs.id)).toBe(f.rns[1]!.id);
  });
});

describe('a nurse’s hours in the pay period', () => {
  // The pay calendar is moved a week so a pay period (09-13…09-26) straddles the published week
  // before the draft, which starts Sunday 09-20.
  function hana() {
    updateUnit(f.handle.db, f.seeded.unitId, { payPeriodAnchor: isoDate('2026-08-30') }, ACTOR);
    const { id: _id, ...base } = f.rns[0]!;
    return rosterApi(f.handle.db).nurses.create({
      ...base,
      employeeId: 'E-HANA-1',
      firstName: 'Hana',
      lastName: 'Okafor',
      role: 'RN',
      fte: 0.9,
      contractedHoursPerPeriod: 72,
      phone: undefined,
      email: undefined,
      notes: undefined,
    });
  }
  const draftId = () => f.seeded.draftPeriodId;
  function workOn(nurseId: string, periodId: string, date: string, reason?: string) {
    return api.createAssignment(
      { periodId, nurseId, shiftTypeId: f.day.id, date: isoDate(date) },
      reason,
    );
  }

  it('counts the published week before this schedule in the pay period that straddles it', () => {
    const h = hana();
    const history = listPeriodsForUnit(f.handle.db, f.seeded.unitId).find(
      (p) => p.status === 'published' && p.startDate === '2026-09-06',
    )!;
    for (const d of ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']) {
      workOn(h.id, history.id, d, 'Hours from paper records');
    }
    workOn(h.id, draftId(), '2026-09-21');
    workOn(h.id, draftId(), '2026-09-22');
    // 4 x 12 = 48 before the draft, 2 x 12 = 24 in it; history reaches back to 08-23 and the pay
    // period ends 09-26, inside the draft.
    expect(api.nurseHours(draftId(), h.id, isoDate('2026-09-21'))).toEqual({
      payPeriod: { start: '2026-09-13', end: '2026-09-26' },
      scheduledHours: 72,
      priorHours: 48,
      paidLeaveHours: 0,
      contractedHours: 72,
      complete: true,
    });
  });

  it('says the count is partial when the pay period runs past the end of this schedule', () => {
    const h = hana();
    workOn(h.id, draftId(), '2026-10-26');
    const readout = api.nurseHours(draftId(), h.id, isoDate('2026-10-26'));
    expect(readout.payPeriod).toEqual({ start: '2026-10-25', end: '2026-11-07' });
    expect(readout.scheduledHours).toBe(12);
    expect(readout.complete).toBe(false);
  });

  it('refuses a nurse who is not on the roster', () => {
    expect(() => api.nurseHours(draftId(), 'nobody-here', isoDate('2026-09-21'))).toThrow(
      /not on .* roster/,
    );
  });
});

describe('the night the clocks go back', () => {
  // Skipped off the pinned zone (phase 1's sentinel): the clock change is a host fact.
  it.skipIf(process.env.SHIFTNURSE_TEST_TZ !== undefined)(
    'judges a schedule with the host’s clock changes in its rule context',
    () => {
      const latest = getLatestRuleSet(f.handle.db, f.seeded.unitId)!;
      const rules = transact(f.handle.db, (tx) =>
        saveRuleSet(
          tx,
          {
            ...latest,
            configs: [
              ...latest.configs.filter((c) => c.ruleId !== 'max-hours-in-24'),
              { ruleId: 'max-hours-in-24', enabled: true, params: { maxHours: 12 } },
            ],
          },
          ACTOR,
        ),
      );
      const period = createPeriod(
        f.handle.db,
        {
          unitId: f.seeded.unitId,
          name: 'Fall back',
          startDate: isoDate('2026-10-26'),
          endDate: isoDate('2026-11-08'),
          ruleSetId: rules.id,
          ruleSetVersion: rules.version,
        },
        ACTOR,
      );
      // The night is shown 19:00 Sat 31 Oct to 07:00 Sun 1 Nov, but the clock goes back at 02:00,
      // so the nurse is on her feet 12 + 1 = 13 real hours: over a 12-hour cap. The 12 hours on
      // the wall clock alone would sit exactly on the cap and pass.
      createAssignment(
        f.handle.db,
        {
          periodId: period.id,
          nurseId: f.rns[0]!.id,
          shiftTypeId: f.night.id,
          date: isoDate('2026-10-31'),
        },
        ACTOR,
      );
      const breaches = api
        .validate(period.id)
        .result.hardViolations.filter((v) => v.code === 'hours_in_24_exceeded');
      expect(breaches).toHaveLength(1);
    },
  );
});
