/**
 * Approving leave and covering the shifts it frees in one decision: the late-request path, so a
 * manager never regenerates a whole schedule — hundreds of shifts reshuffled — to fill two.
 */

import { addDays, describeDate, paidLeaveCredits } from '@shiftnurse/core';
import {
  archivePeriod,
  auditHistoryFor,
  createPeriod,
  createTimeOffRequest,
  denyTimeOff,
  getAssignment,
  getPeriod,
  getTimeOffRequest,
  grantCredential,
  listAssignmentsForPeriod,
  listChanges,
  listCredentials,
  listNurseCredentials,
  listPeriodsForUnit,
  listShiftTypesForUnit,
  markFloatedOff,
  publishSchedule,
  recentAudit,
  transact,
  updateNurse,
  updateUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, buildConflictInput } from './context.js';
import { approveAndCover, coverOptions } from './leave.js';
import { periodsApi, scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

/** Ann works the day shift on day 3 of the draft and then asks for that day off. */
function annAsksOff() {
  const date = addDays(f.seeded.draftStart, 3);
  const shift = scheduleApi(f.handle.db).createAssignment({
    periodId: f.seeded.draftPeriodId,
    nurseId: f.rns[0]!.id,
    shiftTypeId: f.day.id,
    date,
  });
  const request = createTimeOffRequest(
    f.handle.db,
    {
      nurseId: f.rns[0]!.id,
      startDate: date,
      endDate: date,
      type: 'pto',
      paidHours: 12,
    },
    ACTOR,
  );
  return { date, shift, request };
}

const onDay = (date: string, nurseId: string) =>
  listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).filter(
    (a) => a.date === date && a.nurseId === nurseId,
  );

describe('approving leave and covering it in one step', () => {
  it('offers legal nurses for the shift the leave would free, best first', () => {
    const { shift, request } = annAsksOff();
    const options = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    expect(options).toHaveLength(1);
    expect(options[0]!.assignment.id).toBe(shift.id);
    expect(options[0]!.candidates.length).toBeGreaterThan(0);
    expect(options[0]!.candidates.map((c) => c.nurseId)).not.toContain(f.rns[0]!.id);
  });

  it('approves, lifts Ann’s shift and gives it to the chosen nurse together', () => {
    const { date, request } = annAsksOff();
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    const cover = option!.candidates[0]!.nurseId;
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
      { assignmentId: option!.assignment.id, nurseId: cover },
    ]);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('approved');
    expect(onDay(date, f.rns[0]!.id)).toEqual([]);
    expect(onDay(date, cover).map((a) => a.shiftTypeId)).toEqual([f.day.id]);
  });

  it('refuses a cover the rules would not allow, and leaves the request undecided', () => {
    const { request } = annAsksOff();
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    // Ann covering her own shift is the plainest illegal choice.
    expect(() =>
      approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
        { assignmentId: option!.assignment.id, nurseId: f.rns[0]!.id },
      ]),
    ).toThrow(/cannot cover/);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('pending');
  });

  it('approves leave on a posted schedule without asking consent, even where the unit requires it', () => {
    const { request } = annAsksOff();
    transact(f.handle.db, (tx) =>
      publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
    );
    updateUnit(f.handle.db, f.seeded.unitId, { requireConsentForPostedChanges: true }, ACTOR);
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    const cover = option!.candidates[0]!.nurseId;
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, 'Approved: family', [
      { assignmentId: option!.assignment.id, nurseId: cover },
    ]);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('approved');
  });

  it('takes Ann off a published schedule too, under a reason in the change log', () => {
    const { date, request } = annAsksOff();
    transact(f.handle.db, (tx) =>
      publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
    );
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    const cover = option!.candidates[0]!.nurseId;
    const covers = [{ assignmentId: option!.assignment.id, nurseId: cover }];
    expect(() =>
      approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, covers),
    ).toThrow(/requires a reason/);
    approveAndCover(
      f.handle.db,
      f.seeded.draftPeriodId,
      request.id,
      'Approved late: family',
      covers,
    );
    expect(onDay(date, f.rns[0]!.id)).toEqual([]);
    expect(onDay(date, cover)).toHaveLength(1);
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes.map((c) => c.kind).sort()).toEqual(['added', 'removed']);
    expect(changes.every((c) => c.reason === 'Approved late: family')).toBe(true);
  });
});

/** The demo unit's shifts require credentials; the test nurses hold every one, so none decides. */
function grantAclsToAll() {
  for (const credential of listCredentials(f.handle.db)) {
    for (const nurse of f.rns) {
      const has = listNurseCredentials(f.handle.db, nurse.id).some(
        (c) => c.credentialId === credential.id,
      );
      if (!has) {
        grantCredential(f.handle.db, { nurseId: nurse.id, credentialId: credential.id }, ACTOR);
      }
    }
  }
}

/**
 * The seeded roster's order follows random ids, so rns[1] is sometimes a novice, and a novice
 * cannot take charge: with only two nurses charge-eligible, the cover then has nobody to hand
 * charge to and drops out of the candidates. Experienced RNs go first so rns[0] and rns[1] are
 * the two who can.
 */
function makeFirstTwoChargeEligible() {
  f.rns = [...f.rns.filter((n) => !n.isNovice), ...f.rns.filter((n) => n.isNovice)];
  for (const [i, nurse] of f.rns.entries()) {
    updateNurse(f.handle.db, nurse.id, { isChargeEligible: i < 2 }, ACTOR);
  }
}

describe('covering a charge nurse’s leave', () => {
  it('keeps a charge nurse on the shift when her approved leave is covered from the dialog', () => {
    const date = addDays(f.seeded.draftStart, 3);
    const grid = scheduleApi(f.handle.db);
    grantAclsToAll();
    makeFirstTwoChargeEligible();
    grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date,
      isCharge: true,
    });
    const request = createTimeOffRequest(
      f.handle.db,
      { nurseId: f.rns[0]!.id, startDate: date, endDate: date, type: 'pto', paidHours: 12 },
      ACTOR,
    );
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    const cover = option!.candidates.find((c) => c.nurseId === f.rns[1]!.id)!;
    expect(cover).toBeDefined();
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
      { assignmentId: option!.assignment.id, nurseId: cover.nurseId },
    ]);
    expect(onDay(date, cover.nurseId).map((a) => a.isCharge)).toEqual([true]);
  });
});

describe('covering leave with the extra rows a pickup needs', () => {
  function annAsksOffOn(shiftTypeId: string, isCharge = false) {
    const date = addDays(f.seeded.draftStart, 3);
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId,
      date,
      isCharge,
    });
    const request = createTimeOffRequest(
      f.handle.db,
      { nurseId: f.rns[0]!.id, startDate: date, endDate: date, type: 'pto', paidHours: 12 },
      ACTOR,
    );
    return { date, request };
  }

  it('hands charge to the eligible nurse on the shift when the cover cannot take it, on a posted schedule', () => {
    grantAclsToAll();
    makeFirstTwoChargeEligible();
    const { date, request } = annAsksOffOn(f.day.id, true);
    const beaShift = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[1]!.id,
      shiftTypeId: f.day.id,
      date,
    });
    transact(f.handle.db, (tx) =>
      publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
    );
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    const cal = option!.candidates.find((c) => c.takesChargeName !== undefined)!;
    expect(cal.takesChargeName).toBe(`${f.rns[1]!.firstName} ${f.rns[1]!.lastName}`);
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, 'Approved late: family', [
      { assignmentId: option!.assignment.id, nurseId: cal.nurseId },
    ]);

    expect(getAssignment(f.handle.db, beaShift.id)?.isCharge).toBe(true);
    const update = auditHistoryFor(f.handle.db, 'assignment', beaShift.id).find(
      (e) => e.action === 'update',
    );
    expect((update?.before as { isCharge?: boolean } | undefined)?.isCharge).toBe(false);
    const changed = listChanges(f.handle.db, f.seeded.draftPeriodId).filter(
      (c) => c.kind === 'changed',
    );
    expect(changed.map((c) => c.nurseId)).toEqual([f.rns[1]!.id]);
  });

  it('takes the standby off the nurse on call when she covers the night', () => {
    grantAclsToAll();
    const onCall = listShiftTypesForUnit(f.handle.db, f.seeded.unitId).find((s) => s.isOnCall)!;
    const { date, request } = annAsksOffOn(f.night.id);
    const standby = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[1]!.id,
      shiftTypeId: onCall.id,
      date,
    });
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    expect(option!.candidates.find((c) => c.nurseId === f.rns[1]!.id)?.replacesOnCall).toBe(true);
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
      { assignmentId: option!.assignment.id, nurseId: f.rns[1]!.id },
    ]);

    expect(getAssignment(f.handle.db, standby.id)).toBeUndefined();
    expect(auditHistoryFor(f.handle.db, 'assignment', standby.id).map((e) => e.action)).toContain(
      'delete',
    );
    expect(onDay(date, f.rns[1]!.id).map((a) => a.shiftTypeId)).toEqual([f.night.id]);
  });
});

describe('a request that was already decided, or cover that went stale', () => {
  const auditCount = () => recentAudit(f.handle.db, 100_000).length;
  const rosterIds = () =>
    listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId)
      .map((a) => a.id)
      .sort();

  it('refuses to approve a request that was already approved, and writes nothing', () => {
    const { request } = annAsksOff();
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, []);
    const rosterBefore = rosterIds();
    const auditBefore = auditCount();
    expect(() =>
      approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, []),
    ).toThrow('That request is already approved');
    expect(rosterIds()).toEqual(rosterBefore);
    expect(auditCount()).toBe(auditBefore);
  });

  it('refuses to approve a request the manager already denied, and keeps Ann on her shift', () => {
    const { date, request, shift } = annAsksOff();
    denyTimeOff(f.handle.db, request.id, ACTOR, 'Short-staffed that week');
    const auditBefore = auditCount();
    expect(() =>
      approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, []),
    ).toThrow('That request is already denied');
    expect(onDay(date, f.rns[0]!.id).map((a) => a.id)).toEqual([shift.id]);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('denied');
    expect(auditCount()).toBe(auditBefore);
  });

  it('refuses cover that was booked elsewhere while the manager was deciding', () => {
    const { date, request, shift } = annAsksOff();
    const [option] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    const cover = option!.candidates[0]!.nurseId;
    // Someone else puts the chosen nurse on that very shift after the list was shown.
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: cover,
      shiftTypeId: f.day.id,
      date,
    });
    const rosterBefore = rosterIds();
    const auditBefore = auditCount();

    expect(() =>
      approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
        { assignmentId: shift.id, nurseId: cover },
      ]),
    ).toThrow(/cannot cover/);

    // Not half-applied: still pending, Ann still rostered, no row or audit entry written.
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('pending');
    expect(onDay(date, f.rns[0]!.id).map((a) => a.id)).toEqual([shift.id]);
    expect(rosterIds()).toEqual(rosterBefore);
    expect(auditCount()).toBe(auditBefore);
  });
});

describe('which shifts a week off takes away', () => {
  const grid = () => scheduleApi(f.handle.db);
  const ann = () => f.rns[0]!;

  function put(dayIndex: number, shiftTypeId: string) {
    return grid().createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ann().id,
      shiftTypeId,
      date: addDays(f.seeded.draftStart, dayIndex),
    });
  }

  function askOff(fromDay: number, toDay: number, paidHours: number) {
    return createTimeOffRequest(
      f.handle.db,
      {
        nurseId: ann().id,
        startDate: addDays(f.seeded.draftStart, fromDay),
        endDate: addDays(f.seeded.draftStart, toDay),
        type: 'pto',
        paidHours,
      },
      ACTOR,
    );
  }

  const datesOf = () =>
    listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId)
      .filter((a) => a.nurseId === ann().id)
      .map((a) => a.date)
      .sort();

  it('leaves the night that ends on the first morning of leave, and takes the night that starts on it', () => {
    // Nights on day 2 (runs into day 3's morning) and day 3. Leave is day 3 only.
    put(2, f.night.id);
    put(3, f.night.id);
    const request = askOff(3, 3, 0);
    const options = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    expect(options.map((o) => o.assignment.date)).toEqual([addDays(f.seeded.draftStart, 3)]);

    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, []);
    expect(datesOf()).toEqual([addDays(f.seeded.draftStart, 2)]);
  });

  it('splits a week off across the pay-period boundary: shifts and paid hours each in their own', () => {
    // The scenario's pay periods are 14 days, anchored four weeks before the draft, so the draft's
    // day 14 starts a new one: days 0-13 are one pay period, days 14-27 the next.
    put(11, f.day.id);
    put(13, f.day.id); // last day of the first pay period
    put(14, f.day.id); // first day of the second
    put(17, f.day.id);
    // Five days off, days 12-16, paying two 12s: one lands on the 2nd day, one on the 4th
    // (floor(0.5*5/2) = 1 -> day 13; floor(1.5*5/2) = 3 -> day 15).
    const request = askOff(12, 16, 24);
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, []);

    expect(datesOf()).toEqual([addDays(f.seeded.draftStart, 11), addDays(f.seeded.draftStart, 17)]);

    const input = buildConflictInput(f.handle.db, f.seeded.draftPeriodId);
    const credits = paidLeaveCredits(input.timeOff, [], [12]);
    // 12h on day 13 (last day of the first pay period), 12h on day 15 (second).
    expect(credits.map((c) => [c.date, c.hours])).toEqual([
      [addDays(f.seeded.draftStart, 13), 12],
      [addDays(f.seeded.draftStart, 15), 12],
    ]);
  });
});

describe('covering several freed shifts at once', () => {
  const grid = () => scheduleApi(f.handle.db);
  const auditCount = () => recentAudit(f.handle.db, 100_000).length;

  /** Ann works the Day and the Night on one date and asks for that date off. */
  function annDayAndNight() {
    const ann = f.rns[0]!;
    const date = addDays(f.seeded.draftStart, 6);
    for (const shiftTypeId of [f.day.id, f.night.id]) {
      grid().createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: ann.id,
        shiftTypeId,
        date,
      });
    }
    const request = createTimeOffRequest(
      f.handle.db,
      { nurseId: ann.id, startDate: date, endDate: date, type: 'pto', paidHours: 12 },
      ACTOR,
    );
    const [a, b] = coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id);
    return { ann, date, request, a: a!, b: b! };
  }

  it('refuses to give one nurse both the day and the night she could each cover alone, and approves nothing', () => {
    const { ann, request, a, b } = annDayAndNight();
    const shared = a.candidates
      .map((c) => c.nurseId)
      .filter((id) => b.candidates.some((c) => c.nurseId === id));
    expect(shared.length).toBeGreaterThan(0);
    const nurse = shared[0]!;
    const auditBefore = auditCount();

    expect(() =>
      approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
        { assignmentId: a.assignment.id, nurseId: nurse },
        { assignmentId: b.assignment.id, nurseId: nurse },
      ]),
    ).toThrow(/cannot cover .*Already scheduled/);

    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('pending');
    expect(
      listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).filter(
        (x) => x.nurseId === ann.id,
      ),
    ).toHaveLength(2);
    expect(auditCount()).toBe(auditBefore);
  });

  it('refuses two nurses for one freed shift', () => {
    const { request, a } = annDayAndNight();
    const [n1, n2] = a.candidates;
    const auditBefore = auditCount();
    expect(() =>
      approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
        { assignmentId: a.assignment.id, nurseId: n1!.nurseId },
        { assignmentId: a.assignment.id, nurseId: n2!.nurseId },
      ]),
    ).toThrow('Each freed shift can go to one nurse only.');
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('pending');
    expect(auditCount()).toBe(auditBefore);
  });

  it('covers the day and the night with two different nurses', () => {
    const { date, request, a, b } = annDayAndNight();
    const n1 = a.candidates[0]!.nurseId;
    const n2 = b.candidates.find((c) => c.nurseId !== n1)!.nurseId;
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, undefined, [
      { assignmentId: a.assignment.id, nurseId: n1 },
      { assignmentId: b.assignment.id, nurseId: n2 },
    ]);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('approved');
    const rows = listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId);
    const shiftOf = (id: string) => rows.filter((x) => x.nurseId === id && x.date === date);
    expect(shiftOf(n1).map((x) => x.shiftTypeId)).toEqual([a.assignment.shiftTypeId]);
    expect(shiftOf(n2).map((x) => x.shiftTypeId)).toEqual([b.assignment.shiftTypeId]);
  });

  it('keeps a shift lifted from an overlapping draft out of the published period’s change log', () => {
    const ann = f.rns[0]!;
    const date = addDays(f.seeded.draftStart, 8);
    const own = grid().createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date,
    });
    transact(f.handle.db, (tx) =>
      publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
    );
    const other = periodsApi(f.handle.db).create({
      unitId: f.seeded.unitId,
      name: 'Overlapping draft',
      startDate: date,
      endDate: addDays(date, 13),
    });
    const elsewhere = grid().createAssignment({
      periodId: other.id,
      nurseId: ann.id,
      shiftTypeId: f.night.id,
      date,
    });
    const request = createTimeOffRequest(
      f.handle.db,
      { nurseId: ann.id, startDate: date, endDate: date, type: 'pto', paidHours: 12 },
      ACTOR,
    );
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, 'Approved late', []);

    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes.some((c) => c.assignmentId === elsewhere.id)).toBe(false);
    expect(changes.some((c) => c.assignmentId === own.id && c.kind === 'removed')).toBe(true);
    expect(listAssignmentsForPeriod(f.handle.db, other.id)).toEqual([]);
  });
});

describe('leave over a day she was floated off', () => {
  it('neither offers her floated shift for cover nor takes it off when the leave is approved', () => {
    const { date, shift, request } = annAsksOff();
    transact(f.handle.db, (tx) =>
      publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
    );
    transact(f.handle.db, (tx) => markFloatedOff(tx, shift.id, '5 East', ACTOR));
    expect(coverOptions(f.handle.db, f.seeded.draftPeriodId, request.id)).toEqual([]);
    approveAndCover(f.handle.db, f.seeded.draftPeriodId, request.id, 'Approved late: family', []);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('approved');
    // She worked that day on 5 East; the row is the record of those hours.
    expect(onDay(date, f.rns[0]!.id)).toEqual([
      expect.objectContaining({ id: shift.id, floatedTo: '5 East', isLocked: true }),
    ]);
    expect(listChanges(f.handle.db, f.seeded.draftPeriodId)).toEqual([]);
  });
});

describe('a request that spans a posted period and the draft after it', () => {
  const auditCount = () => recentAudit(f.handle.db, 100_000).length;

  /**
   * P is the seeded period, published; Q the draft for the 14 days after it. Ann works the day
   * shift on P's last two days and Q's first, then asks for those three days off.
   */
  function straddle() {
    const db = f.handle.db;
    const P = f.seeded.draftPeriodId;
    const seededPeriod = getPeriod(db, P)!;
    const Q = createPeriod(
      db,
      {
        unitId: f.seeded.unitId,
        name: 'Next period',
        startDate: addDays(f.seeded.draftEnd, 1),
        endDate: addDays(f.seeded.draftEnd, 14),
        ruleSetId: seededPeriod.ruleSetId,
        ruleSetVersion: seededPeriod.ruleSetVersion,
      },
      ACTOR,
    ).id;
    const ann = f.rns[0]!;
    const dates = [-1, 0, 1].map((k) => addDays(f.seeded.draftEnd, k));
    const shifts = dates.map((date, k) =>
      scheduleApi(db).createAssignment({
        periodId: k < 2 ? P : Q,
        nurseId: ann.id,
        shiftTypeId: f.day.id,
        date,
      }),
    );
    transact(db, (tx) => publishSchedule(tx, { periodId: P, ledger: [] }, ACTOR));
    const request = createTimeOffRequest(
      db,
      {
        nurseId: ann.id,
        startDate: dates[0]!,
        endDate: dates[2]!,
        type: 'pto',
        paidHours: 36,
      },
      ACTOR,
    );
    const annOn = (date: string) =>
      [...listAssignmentsForPeriod(db, P), ...listAssignmentsForPeriod(db, Q)].filter(
        (a) => a.nurseId === ann.id && a.date === date,
      );
    return { P, Q, ann, dates, shifts, request, annOn };
  }

  it('offers cover for the posted days as well as the draft day of a request that spans both', () => {
    const { P, Q, request } = straddle();
    // Three shifts dated inside the request: one on Q (the anchor, so first), two on P.
    expect(
      coverOptions(f.handle.db, Q, request.id).map((o) => [
        o.assignment.periodId,
        o.assignment.date,
      ]),
    ).toEqual([
      [Q, addDays(f.seeded.draftEnd, 1)],
      [P, addDays(f.seeded.draftEnd, -1)],
      [P, f.seeded.draftEnd],
    ]);
  });

  it('refuses to take posted shifts off without a reason, and changes nothing', () => {
    const { Q, dates, request, annOn } = straddle();
    const auditBefore = auditCount();
    expect(() => approveAndCover(f.handle.db, Q, request.id, undefined, [])).toThrow(
      /requires a reason/,
    );
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('pending');
    for (const date of dates) expect(annOn(date)).toHaveLength(1);
    expect(auditCount()).toBe(auditBefore);
  });

  it('takes every posted shift off under the reason and logs each in its own period', () => {
    const { P, Q, dates, request, annOn } = straddle();
    approveAndCover(f.handle.db, Q, request.id, 'Family emergency', []);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('approved');
    for (const date of dates) expect(annOn(date)).toEqual([]);
    const changes = listChanges(f.handle.db, P);
    expect(changes.map((c) => [c.kind, c.date, c.reason]).sort()).toEqual([
      ['removed', addDays(f.seeded.draftEnd, -1), 'Family emergency'],
      ['removed', f.seeded.draftEnd, 'Family emergency'],
    ]);
    // Q is a draft: its change log is a no-op.
    expect(listChanges(f.handle.db, Q)).toEqual([]);
  });

  it('covers a posted day and the draft day in one decision', () => {
    const { P, Q, request } = straddle();
    const options = coverOptions(f.handle.db, Q, request.id);
    const onP = options.find(
      (o) => o.assignment.periodId === P && o.assignment.date === f.seeded.draftEnd,
    )!;
    const onQ = options.find((o) => o.assignment.periodId === Q)!;
    const n1 = onP.candidates[0]!.nurseId;
    const n2 = onQ.candidates.find((c) => c.nurseId !== n1)!.nurseId;
    approveAndCover(f.handle.db, Q, request.id, 'Family emergency', [
      { assignmentId: onP.assignment.id, nurseId: n1 },
      { assignmentId: onQ.assignment.id, nurseId: n2 },
    ]);
    expect(
      listAssignmentsForPeriod(f.handle.db, P).filter(
        (a) => a.nurseId === n1 && a.date === f.seeded.draftEnd,
      ),
    ).toEqual([expect.objectContaining({ periodId: P, shiftTypeId: f.day.id })]);
    expect(
      listAssignmentsForPeriod(f.handle.db, Q).filter(
        (a) => a.nurseId === n2 && a.date === addDays(f.seeded.draftEnd, 1),
      ),
    ).toEqual([expect.objectContaining({ periodId: Q, shiftTypeId: f.day.id })]);
    const changes = listChanges(f.handle.db, P);
    expect(changes.filter((c) => c.kind === 'added').map((c) => c.nurseId)).toEqual([n1]);
    // Ann's two posted days, each taken off under the reason.
    expect(
      changes
        .filter((c) => c.kind === 'removed')
        .map((c) => c.date)
        .sort(),
    ).toEqual([addDays(f.seeded.draftEnd, -1), f.seeded.draftEnd]);
    expect(listChanges(f.handle.db, Q)).toEqual([]);
  });

  it('undoes the posted cover too when the draft day’s cover is refused', () => {
    const { P, Q, ann, dates, request, annOn } = straddle();
    const options = coverOptions(f.handle.db, Q, request.id);
    const onP = options.find((o) => o.assignment.periodId === P)!;
    const onQ = options.find((o) => o.assignment.periodId === Q)!;
    const auditBefore = auditCount();
    // P's cover is judged first and is legal; Ann covering her own draft day is not.
    expect(() =>
      approveAndCover(f.handle.db, Q, request.id, 'Family emergency', [
        { assignmentId: onP.assignment.id, nurseId: onP.candidates[0]!.nurseId },
        { assignmentId: onQ.assignment.id, nurseId: ann.id },
      ]),
    ).toThrow(/cannot cover/);
    expect(getTimeOffRequest(f.handle.db, request.id)?.status).toBe('pending');
    for (const date of dates) expect(annOn(date)).toHaveLength(1);
    expect(listChanges(f.handle.db, P)).toEqual([]);
    expect(auditCount()).toBe(auditBefore);
  });

  it('refuses a draft-day cover that would follow the same nurse’s posted night with no rest', () => {
    const db = f.handle.db;
    const P = f.seeded.draftPeriodId;
    const seededPeriod = getPeriod(db, P)!;
    const Q = createPeriod(
      db,
      {
        unitId: f.seeded.unitId,
        name: 'Next period',
        startDate: addDays(f.seeded.draftEnd, 1),
        endDate: addDays(f.seeded.draftEnd, 14),
        ruleSetId: seededPeriod.ruleSetId,
        ruleSetVersion: seededPeriod.ruleSetVersion,
      },
      ACTOR,
    ).id;
    const ann = f.rns[0]!;
    // Ann's night on P's last day ends at 07:00 on Q's first day, when her day shift starts.
    scheduleApi(db).createAssignment({
      periodId: P,
      nurseId: ann.id,
      shiftTypeId: f.night.id,
      date: f.seeded.draftEnd,
    });
    transact(db, (tx) => publishSchedule(tx, { periodId: P, ledger: [] }, ACTOR));
    scheduleApi(db).createAssignment({
      periodId: Q,
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftEnd, 1),
    });
    const request = createTimeOffRequest(
      db,
      {
        nurseId: ann.id,
        startDate: f.seeded.draftEnd,
        endDate: addDays(f.seeded.draftEnd, 1),
        type: 'pto',
        paidHours: 24,
      },
      ACTOR,
    );
    const options = coverOptions(db, Q, request.id);
    const onQ = options.find((o) => o.assignment.periodId === Q)!;
    const onP = options.find((o) => o.assignment.periodId === P)!;
    // Legal for either shift alone; both together is a night then a day with 0 hours between.
    const both = onP.candidates.find((c) => onQ.candidates.some((d) => d.nurseId === c.nurseId));
    expect(both).toBeDefined();
    // Main judges P before Q although Q is the anchor, so Q's cover is the one refused.
    expect(() =>
      approveAndCover(db, Q, request.id, 'Family emergency', [
        { assignmentId: onQ.assignment.id, nurseId: both!.nurseId },
        { assignmentId: onP.assignment.id, nurseId: both!.nurseId },
      ]),
    ).toThrow(`cannot cover ${describeDate(addDays(f.seeded.draftEnd, 1))}`);
    expect(getTimeOffRequest(db, request.id)?.status).toBe('pending');
  });
});

describe('a request that reaches back into an archived period', () => {
  it('takes the draft shift off and leaves the archived record alone', () => {
    const db = f.handle.db;
    const P = f.seeded.draftPeriodId;
    const dayBefore = addDays(f.seeded.draftStart, -1);
    // The scenario's history ends the day before the draft starts; close that period.
    const archived = listPeriodsForUnit(db, f.seeded.unitId).find((p) => p.endDate === dayBefore)!;
    archivePeriod(db, archived.id, ACTOR, 'Pay period closed');
    const recordBefore = listAssignmentsForPeriod(db, archived.id);
    const worked = recordBefore.find((a) => a.date === dayBefore && a.shiftTypeId === f.day.id)!;
    const nurseId = worked.nurseId;
    scheduleApi(db).createAssignment({
      periodId: P,
      nurseId,
      shiftTypeId: f.day.id,
      date: f.seeded.draftStart,
    });
    const request = createTimeOffRequest(
      db,
      { nurseId, startDate: dayBefore, endDate: f.seeded.draftStart, type: 'pto', paidHours: 24 },
      ACTOR,
    );
    // Only the draft day is offered: the archived day is history.
    expect(coverOptions(db, P, request.id).map((o) => o.assignment.date)).toEqual([
      f.seeded.draftStart,
    ]);
    approveAndCover(db, P, request.id, undefined, []);
    expect(getTimeOffRequest(db, request.id)?.status).toBe('approved');
    expect(listAssignmentsForPeriod(db, archived.id)).toEqual(recordBefore);
    expect(listAssignmentsForPeriod(db, P).filter((a) => a.nurseId === nurseId)).toEqual([]);
    expect(listChanges(db, archived.id)).toEqual([]);
  });
});
