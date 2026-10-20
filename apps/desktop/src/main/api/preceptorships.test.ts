/**
 * Orientations through the IPC handlers: each write lands with its audit row, an entry naming two
 * preceptors is one record each or none, and the period's input and the grid's own validation both
 * see the orientation, so an orientee working alone is flagged where the manager is looking.
 */

import { addDays } from '@shiftnurse/core';
import { auditHistoryFor, getPeriod, loadPeriodInput } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preceptorshipsApi } from './preceptorships.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const api = () => preceptorshipsApi(f.handle.db);

// The fixture's RNs sort by generated id, so any index may be a new grad, who cannot precept.
const mentor = (i: number) => f.rns.filter((n) => !n.isNovice && n.id !== f.rns[0]!.id)[i]!;

function orientation(preceptorIds: string[]) {
  const period = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
  return {
    unitId: f.seeded.unitId,
    orienteeId: f.rns[0]!.id,
    preceptorIds,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}

describe('recording an orientation', () => {
  it('records one row per preceptor and audits each', () => {
    const records = api().create(orientation([mentor(0).id, mentor(1).id]));
    expect(records.map((r) => r.preceptorId)).toEqual([mentor(0).id, mentor(1).id]);
    // Same start date, so the list breaks the tie by id: compare as sets.
    expect(
      new Set(
        api()
          .list(f.seeded.unitId)
          .map((r) => r.id),
      ),
    ).toEqual(new Set(records.map((r) => r.id)));
    for (const r of records) {
      expect(auditHistoryFor(f.handle.db, 'preceptorship', r.id)[0]).toMatchObject({
        action: 'create',
        actor: 'manager',
      });
    }
  });

  it('records nothing when one of the preceptors is the orientee', () => {
    expect(() => api().create(orientation([mentor(0).id, f.rns[0]!.id]))).toThrow(
      'A nurse cannot be their own preceptor',
    );
    expect(api().list(f.seeded.unitId)).toEqual([]);
  });

  it('puts the orientation in the period input Generate and conflicts read', () => {
    const [record] = api().create(orientation([mentor(0).id]));
    const period = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
    expect(loadPeriodInput(f.handle.db, period).preceptorships).toEqual([record]);
  });
});

describe('the grid with an orientee on it', () => {
  const place = (nurseId: string, shiftTypeId: string) =>
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId,
      shiftTypeId,
      date: addDays(f.seeded.draftStart, 3),
    });
  const flagged = () =>
    scheduleApi(f.handle.db)
      .validate(f.seeded.draftPeriodId)
      .result.violations.filter((v) => v.code === 'orientee_without_preceptor');

  it('flags an orientee working without their preceptor, and stops once the preceptor joins', () => {
    api().create(orientation([mentor(0).id]));
    const alone = place(f.rns[0]!.id, f.day.id);
    const violations = flagged();
    expect(violations).toHaveLength(1);
    expect(violations[0]!.assignmentIds).toEqual([alone.id]);

    place(mentor(0).id, f.day.id);
    expect(flagged()).toEqual([]);
  });

  it('flags nobody when no orientation is recorded', () => {
    place(f.rns[0]!.id, f.day.id);
    expect(flagged()).toEqual([]);
  });
});
