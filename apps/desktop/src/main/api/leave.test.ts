/**
 * Approving leave and covering the shifts it frees in one decision: the late-request path, so a
 * manager never regenerates a whole schedule — hundreds of shifts reshuffled — to fill two.
 */

import { addDays, paidLeaveCredits } from '@shiftnurse/core';
import {
  createTimeOffRequest,
  denyTimeOff,
  getTimeOffRequest,
  listAssignmentsForPeriod,
  listChanges,
  publishSchedule,
  recentAudit,
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
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
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
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
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
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
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
