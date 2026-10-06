/**
 * Rest waivers through the IPC handlers: each write lands with its audit row and reason, the
 * period's input carries the waiver, and the grid's own validation lets the waived turnaround
 * stand where the manager is looking.
 */

import { addDays } from '@shiftnurse/core';
import { auditHistoryFor, getPeriod, loadPeriodInput } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restWaiversApi } from './rest-waivers.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const api = () => restWaiversApi(f.handle.db);
const day = (offset: number) => addDays(f.seeded.draftStart, offset);

function waiver(offset: number) {
  return {
    unitId: f.seeded.unitId,
    nurseId: f.rns[0]!.id,
    date: day(offset),
    reason: 'Signed waiver, took the evening',
  };
}

describe('recording a rest waiver', () => {
  it('records it, audits it with the reason and lists it', () => {
    const record = api().create(waiver(3));
    expect(api().list(f.seeded.unitId)).toEqual([record]);
    expect(auditHistoryFor(f.handle.db, 'rest_waiver', record.id)[0]).toMatchObject({
      action: 'create',
      actor: 'manager',
      reason: 'Signed waiver, took the evening',
    });
  });

  it('refuses a blank reason and records nothing', () => {
    expect(() => api().create({ ...waiver(3), reason: ' ' })).toThrow(/Give a reason/);
    expect(api().list(f.seeded.unitId)).toEqual([]);
  });

  it('removes it under a stated reason', () => {
    const record = api().create(waiver(3));
    expect(() => api().remove(record.id, '')).toThrow(/Give a reason/);
    api().remove(record.id, 'Nurse withdrew it');
    expect(api().list(f.seeded.unitId)).toEqual([]);
    expect(auditHistoryFor(f.handle.db, 'rest_waiver', record.id)[0]).toMatchObject({
      action: 'delete',
      reason: 'Nurse withdrew it',
    });
  });

  it('puts the waiver in the period input Generate and conflicts read', () => {
    const record = api().create(waiver(3));
    api().create({ ...waiver(200), nurseId: f.rns[1]!.id });
    const period = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
    expect(loadPeriodInput(f.handle.db, period).restWaivers).toEqual([record]);
  });
});

describe('the grid with a waived turnaround on it', () => {
  const place = (shiftTypeId: string, offset: number) =>
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId,
      date: day(offset),
    });
  const flagged = () =>
    scheduleApi(f.handle.db)
      .validate(f.seeded.draftPeriodId)
      .result.violations.filter((v) => v.code === 'insufficient_rest');

  it('flags the night-to-day turnaround until the nurse waives it for that day', () => {
    place(f.night.id, 3);
    place(f.day.id, 4);
    expect(flagged()).toHaveLength(1);

    api().create(waiver(4));
    expect(flagged()).toEqual([]);
  });

  it('keeps flagging it when the waiver is for the night before', () => {
    place(f.night.id, 3);
    place(f.day.id, 4);
    api().create(waiver(3));
    expect(flagged()).toHaveLength(1);
  });
});
