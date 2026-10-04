/**
 * Overtime offers through the IPC handlers: each write lands with its audit row, a refusal
 * reaches the caller in words, and the period's input — what Generate, the grid and the day-of
 * list all judge by — carries the offers.
 */

import { isoDate } from '@shiftnurse/core';
import { auditHistoryFor, getPeriod, loadPeriodInput } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overtimeVolunteersApi } from './overtime-volunteers.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const api = () => overtimeVolunteersApi(f.handle.db);
const auditsOf = (id: string) => auditHistoryFor(f.handle.db, 'overtime_volunteer', id);

function offer(startDate: string, endDate: string) {
  return {
    unitId: f.seeded.unitId,
    nurseId: f.rns[0]!.id,
    startDate: isoDate(startDate),
    endDate: isoDate(endDate),
    note: 'texted Oct 3: any nights that week',
  };
}

describe('recording an overtime offer', () => {
  it('lists, edits and removes an offer, auditing each step', () => {
    const v = api().create(offer('2026-10-05', '2026-10-11'));
    expect(api().list(f.seeded.unitId)).toEqual([v]);

    api().update(v.id, { endDate: isoDate('2026-10-14'), note: null });
    expect(api().list(f.seeded.unitId)[0]).toMatchObject({ endDate: '2026-10-14' });
    expect(api().list(f.seeded.unitId)[0]!.note).toBeUndefined();

    api().remove(v.id);
    expect(api().list(f.seeded.unitId)).toEqual([]);
    expect(
      auditsOf(v.id)
        .map((e) => e.action)
        .reverse(),
    ).toEqual(['create', 'update', 'delete']);
    expect(auditsOf(v.id)[0]).toMatchObject({ actor: 'manager', before: expect.anything() });
  });

  it('says so when the offer ends before it starts, and records nothing', () => {
    expect(() => api().create(offer('2026-10-11', '2026-10-05'))).toThrow(/ends before it starts/);
    expect(api().list(f.seeded.unitId)).toEqual([]);
  });

  it('puts the offer in the period input the grid and Generate read', () => {
    const period = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
    const v = api().create({
      ...offer(period.startDate, period.startDate),
    });
    expect(loadPeriodInput(f.handle.db, period).overtimeVolunteers).toEqual([v]);
  });
});
