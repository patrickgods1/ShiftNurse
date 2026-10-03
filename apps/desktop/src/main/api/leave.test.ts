/**
 * Approving leave and covering the shifts it frees in one decision: the late-request path, so a
 * manager never regenerates a whole schedule — hundreds of shifts reshuffled — to fill two.
 */

import { addDays } from '@shiftnurse/core';
import {
  createTimeOffRequest,
  getTimeOffRequest,
  listAssignmentsForPeriod,
  listChanges,
  publishSchedule,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { approveAndCover, coverOptions } from './leave.js';
import { scheduleApi } from './schedule.js';
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
